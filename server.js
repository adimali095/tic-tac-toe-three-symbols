const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, "public")));

// Root route with error handling
app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "public", "index.html");
  console.log("Serving file:", filePath);

  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    console.error("File not found:", filePath);
    res.status(404).send("index.html not found");
  }
});

// Debug endpoint
app.get("/debug", (req, res) => {
  const filePath = path.join(__dirname, "public", "index.html");
  res.json({
    __dirname: __dirname,
    filePath: filePath,
    exists: fs.existsSync(filePath),
    publicDir: fs.existsSync(path.join(__dirname, "public")),
  });
});

// Configuration
const CONFIG = {
  MAX_SYMBOLS: 3,
  MOVE_TIMEOUT: 30000, // 30 seconds per move
  ROOM_EXPIRY: 3600000, // 1 hour
  MAX_ROOM_NAME_LENGTH: 50,
  RATE_LIMIT_WINDOW: 1000, // 1 second
  MAX_MOVES_PER_WINDOW: 5,
};

// Data structures
const games = new Map();
const players = new Map();
const rateLimits = new Map();
const roomTimers = new Map();

// Utility: Generate unique player ID
function generatePlayerId() {
  return crypto.randomBytes(8).toString("hex");
}

// Utility: Validate room ID
function isValidRoomId(roomId) {
  return (
    roomId &&
    typeof roomId === "string" &&
    roomId.length > 0 &&
    roomId.length <= CONFIG.MAX_ROOM_NAME_LENGTH &&
    /^[a-zA-Z0-9-_]+$/.test(roomId)
  );
}

// Utility: Check winner
function checkWinner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8], // Rows
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8], // Columns
    [0, 4, 8],
    [2, 4, 6], // Diagonals
  ];

  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }

  const isFull = board.every((cell) => cell !== "");
  return isFull ? { winner: "draw", line: null } : null;
}

// Utility: Rate limiting
function checkRateLimit(socketId) {
  const now = Date.now();
  const limit = rateLimits.get(socketId) || {
    count: 0,
    resetTime: now + CONFIG.RATE_LIMIT_WINDOW,
  };

  if (now > limit.resetTime) {
    limit.count = 1;
    limit.resetTime = now + CONFIG.RATE_LIMIT_WINDOW;
  } else {
    limit.count++;
  }

  rateLimits.set(socketId, limit);
  return limit.count <= CONFIG.MAX_MOVES_PER_WINDOW;
}

// Utility: Create new game
function createGame() {
  return {
    board: Array(9).fill(""),
    currentPlayer: "X",
    moves: { X: [], O: [] },
    moveHistory: [],
    winner: null,
    winningLine: null,
    gameStatus: "waiting", // waiting, playing, finished
    createdAt: Date.now(),
    lastActivity: Date.now(),
    turnStartTime: null,
    scores: { X: 0, O: 0, draws: 0 },
  };
}

// Utility: Start move timer
function startMoveTimer(roomId) {
  const game = games.get(roomId);
  if (!game || game.gameStatus !== "playing") return;

  clearTimeout(roomTimers.get(`${roomId}-move`));

  game.turnStartTime = Date.now();
  const timer = setTimeout(() => {
    const currentGame = games.get(roomId);
    if (!currentGame || currentGame.gameStatus !== "playing") return;

    // Auto-forfeit on timeout
    const winner = currentGame.currentPlayer === "X" ? "O" : "X";
    currentGame.winner = winner;
    currentGame.gameStatus = "finished";
    currentGame.scores[winner]++;

    io.to(roomId).emit("gameOver", {
      winner,
      reason: "timeout",
      message: `${currentGame.currentPlayer} ran out of time!`,
    });
    io.to(roomId).emit("update", currentGame);
  }, CONFIG.MOVE_TIMEOUT);

  roomTimers.set(`${roomId}-move`, timer);
}

// Utility: Clear room timers
function clearRoomTimers(roomId) {
  clearTimeout(roomTimers.get(`${roomId}-move`));
  clearTimeout(roomTimers.get(`${roomId}-expiry`));
  roomTimers.delete(`${roomId}-move`);
  roomTimers.delete(`${roomId}-expiry`);
}

// Utility: Start room expiry timer
function startRoomExpiryTimer(roomId) {
  clearTimeout(roomTimers.get(`${roomId}-expiry`));

  const timer = setTimeout(() => {
    cleanupRoom(roomId);
    console.log(`Room ${roomId} expired due to inactivity`);
  }, CONFIG.ROOM_EXPIRY);

  roomTimers.set(`${roomId}-expiry`, timer);
}

// Utility: Cleanup room
function cleanupRoom(roomId) {
  games.delete(roomId);
  players.delete(roomId);
  clearRoomTimers(roomId);
}

// Utility: Get room statistics
function getRoomStats(roomId) {
  const game = games.get(roomId);
  const roomPlayers = players.get(roomId) || {};

  const playersList = Object.entries(roomPlayers)
    .filter(([_, data]) => data.role !== "spectator")
    .reduce((acc, [id, data]) => {
      acc[data.role] = { id: data.playerId, socketId: id };
      return acc;
    }, {});

  const spectatorCount = Object.values(roomPlayers).filter(
    (p) => p.role === "spectator"
  ).length;

  return {
    players: playersList,
    spectators: spectatorCount,
    gameStatus: game?.gameStatus || "waiting",
    scores: game?.scores || { X: 0, O: 0, draws: 0 },
  };
}

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log(`New connection: ${socket.id}`);

  socket.on("joinGame", (roomId, playerName) => {
    // Validation
    if (!isValidRoomId(roomId)) {
      socket.emit("error", { message: "Invalid room ID" });
      return;
    }

    socket.join(roomId);

    // Initialize game and players
    if (!games.has(roomId)) {
      games.set(roomId, createGame());
      players.set(roomId, {});
      startRoomExpiryTimer(roomId);
    }

    const game = games.get(roomId);
    const roomPlayers = players.get(roomId);

    // Assign player role
    if (!roomPlayers[socket.id]) {
      const existingRoles = Object.values(roomPlayers).map((p) => p.role);
      const playerId = playerName || generatePlayerId();

      let role = "spectator";
      if (!existingRoles.includes("X")) {
        role = "X";
      } else if (!existingRoles.includes("O")) {
        role = "O";
      }

      roomPlayers[socket.id] = {
        role,
        playerId,
        joinedAt: Date.now(),
      };

      // Start game when both players join
      if (existingRoles.length === 1 && role !== "spectator") {
        game.gameStatus = "playing";
        startMoveTimer(roomId);
      }
    }

    const myPlayer = roomPlayers[socket.id];
    const stats = getRoomStats(roomId);

    // Send initial state
    socket.emit("init", {
      ...game,
      myPlayer: myPlayer.role,
      playerId: myPlayer.playerId,
      roomId,
      ...stats,
    });

    // Notify room
    socket.to(roomId).emit("playerJoined", {
      playerId: myPlayer.playerId,
      role: myPlayer.role,
      ...stats,
    });

    console.log(
      `${myPlayer.playerId} (${myPlayer.role}) joined room ${roomId}`
    );
  });

  // Make move
  socket.on("makeMove", ({ roomId, index }) => {
    if (!checkRateLimit(socket.id)) {
      socket.emit("error", { message: "Too many requests. Slow down!" });
      return;
    }

    const game = games.get(roomId);
    const roomPlayers = players.get(roomId);

    if (!game || !roomPlayers) {
      socket.emit("error", { message: "Game not found" });
      return;
    }

    const player = roomPlayers[socket.id]?.role;

    // Validations
    if (!player || player === "spectator") {
      socket.emit("error", { message: "You are a spectator" });
      return;
    }
    if (game.gameStatus !== "playing") {
      socket.emit("error", { message: "Game is not active" });
      return;
    }
    if (player !== game.currentPlayer) {
      socket.emit("error", { message: "Not your turn" });
      return;
    }
    if (game.moves[player].length >= CONFIG.MAX_SYMBOLS) {
      socket.emit("error", {
        message: `Maximum ${CONFIG.MAX_SYMBOLS} symbols placed. Remove one first.`,
      });
      return;
    }
    if (index < 0 || index > 8) {
      socket.emit("error", { message: "Invalid cell index" });
      return;
    }
    if (game.board[index] !== "") {
      socket.emit("error", { message: "Cell already occupied" });
      return;
    }

    // Make move
    game.board[index] = player;
    game.moves[player].push(index);
    game.moveHistory.push({
      type: "place",
      player,
      index,
      timestamp: Date.now(),
    });
    game.lastActivity = Date.now();

    // Check for winner
    const result = checkWinner(game.board);
    if (result) {
      game.winner = result.winner;
      game.winningLine = result.line;
      game.gameStatus = "finished";
      clearTimeout(roomTimers.get(`${roomId}-move`));

      if (result.winner !== "draw") {
        game.scores[result.winner]++;
      } else {
        game.scores.draws++;
      }

      io.to(roomId).emit("gameOver", {
        winner: result.winner,
        line: result.line,
        scores: game.scores,
      });
    } else {
      game.currentPlayer = player === "X" ? "O" : "X";
      startMoveTimer(roomId);
    }

    io.to(roomId).emit("update", game);
  });

  // Remove symbol
  socket.on("removeSymbol", ({ roomId, index }) => {
    if (!checkRateLimit(socket.id)) {
      socket.emit("error", { message: "Too many requests. Slow down!" });
      return;
    }

    const game = games.get(roomId);
    const roomPlayers = players.get(roomId);

    if (!game || !roomPlayers) return;

    const player = roomPlayers[socket.id]?.role;

    // Validations
    if (!player || player === "spectator") {
      socket.emit("error", { message: "You are a spectator" });
      return;
    }
    if (game.gameStatus !== "playing") {
      socket.emit("error", { message: "Game is not active" });
      return;
    }
    if (player !== game.currentPlayer) {
      socket.emit("error", { message: "Not your turn" });
      return;
    }
    if (game.board[index] !== player) {
      socket.emit("error", { message: "Cannot remove this symbol" });
      return;
    }

    // Remove symbol
    game.board[index] = "";
    game.moves[player] = game.moves[player].filter((i) => i !== index);
    game.moveHistory.push({
      type: "remove",
      player,
      index,
      timestamp: Date.now(),
    });
    game.lastActivity = Date.now();
    game.currentPlayer = player === "X" ? "O" : "X";

    startMoveTimer(roomId);
    io.to(roomId).emit("update", game);
  });

  // Request rematch
  socket.on("rematch", ({ roomId }) => {
    const game = games.get(roomId);
    const roomPlayers = players.get(roomId);

    if (!game || !roomPlayers) return;

    const player = roomPlayers[socket.id]?.role;
    if (!player || player === "spectator") return;

    // Reset game but keep scores
    const scores = game.scores;
    const newGame = createGame();
    newGame.scores = scores;
    newGame.gameStatus = "playing";

    games.set(roomId, newGame);
    startMoveTimer(roomId);

    io.to(roomId).emit("update", newGame);
    io.to(roomId).emit("gameReset", { scores });
  });

  // Get room info
  socket.on("getRoomInfo", ({ roomId }) => {
    const stats = getRoomStats(roomId);
    socket.emit("roomInfo", stats);
  });

  // Chat message
  socket.on("chatMessage", ({ roomId, message }) => {
    const roomPlayers = players.get(roomId);
    if (!roomPlayers || !roomPlayers[socket.id]) return;

    const player = roomPlayers[socket.id];
    const sanitized = message.slice(0, 200); // Limit message length

    io.to(roomId).emit("chatMessage", {
      playerId: player.playerId,
      role: player.role,
      message: sanitized,
      timestamp: Date.now(),
    });
  });

  // Disconnect handler
  socket.on("disconnect", () => {
    console.log(`Disconnected: ${socket.id}`);

    // Cleanup player from all rooms
    for (const [roomId, roomPlayers] of players.entries()) {
      if (roomPlayers[socket.id]) {
        const player = roomPlayers[socket.id];
        delete roomPlayers[socket.id];

        socket.to(roomId).emit("playerLeft", {
          playerId: player.playerId,
          role: player.role,
          ...getRoomStats(roomId),
        });

        // Clean up empty rooms
        if (Object.keys(roomPlayers).length === 0) {
          cleanupRoom(roomId);
          console.log(`Room ${roomId} cleaned up - no players remaining`);
        } else if (player.role !== "spectator") {
          // Pause game if active player leaves
          const game = games.get(roomId);
          if (game) {
            game.gameStatus = "waiting";
            clearTimeout(roomTimers.get(`${roomId}-move`));
            io.to(roomId).emit("update", game);
          }
        }
      }
    }

    rateLimits.delete(socket.id);
  });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`✓ Max symbols per player: ${CONFIG.MAX_SYMBOLS}`);
  console.log(`✓ Move timeout: ${CONFIG.MOVE_TIMEOUT / 1000}s`);
  console.log(`✓ Room expiry: ${CONFIG.ROOM_EXPIRY / 60000}min`);
});
