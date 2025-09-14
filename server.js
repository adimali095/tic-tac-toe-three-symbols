const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // optional if frontend served from same domain
});

// Serve static frontend
app.use(express.static(path.join(__dirname, "public")));

const games = {}; // Store game state per room
const players = {}; // Track which socket is X or O

io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  socket.on("joinGame", (roomId) => {
    socket.join(roomId);

    // Create game if it doesn't exist
    if (!games[roomId]) {
      games[roomId] = {
        board: Array(9).fill(""),
        currentPlayer: "X",
        moves: { X: [], O: [] },
        removedStack: [],
      };
      players[roomId] = {};
    }

    // Assign player symbol
    if (!players[roomId][socket.id]) {
      const assigned = Object.values(players[roomId]).includes("X") ? "O" : "X";
      players[roomId][socket.id] = assigned;
    }

    const myPlayer = players[roomId][socket.id];

    // Send initial state
    socket.emit("init", { ...games[roomId], myPlayer });
  });

  socket.on("makeMove", ({ roomId, index, player }) => {
    const game = games[roomId];
    if (!game) return;

    if (player !== game.currentPlayer) return;
    if (game.moves[player].length >= 3) return;
    if (game.board[index] !== "") return;

    game.board[index] = player;
    game.moves[player].push(index);
    game.currentPlayer = player === "X" ? "O" : "X";

    io.to(roomId).emit("update", game);
  });

  socket.on("removeSymbol", ({ roomId, index, player }) => {
    const game = games[roomId];
    if (!game) return;

    if (game.board[index] === player) {
      game.board[index] = "";
      game.moves[player] = game.moves[player].filter((i) => i !== index);
      game.removedStack.push({ player, index });
      io.to(roomId).emit("update", game);
    }
  });

  socket.on("undo", ({ roomId }) => {
    const game = games[roomId];
    if (!game || game.removedStack.length === 0) return;

    const { player, index } = game.removedStack.pop();
    game.board[index] = player;
    game.moves[player].push(index);
    io.to(roomId).emit("update", game);
  });

  socket.on("resetGame", ({ roomId }) => {
    games[roomId] = {
      board: Array(9).fill(""),
      currentPlayer: "X",
      moves: { X: [], O: [] },
      removedStack: [],
    };
    io.to(roomId).emit("update", games[roomId]);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
