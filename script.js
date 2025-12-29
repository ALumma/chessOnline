const globals = {
    turn: true, // true = white, false = black
    isWhiteView: true,
    selected: null,
    boardState: [],
    boardLength: 8,
    enPassant: null,
    castle: { wK: true, wQ: true, bK: true, bQ: true },
    repetition: new Map(),
    halfMoveClock: 0,
    // Network
    isHost: false,
    myColor: true,
    peer: null,
    connected: false,

    roomCode: null,
    _sentOffer: false,
    _sentAnswer: false
};

// Signaling

const SIGNAL_BASE = `${location.origin}/projects/chessOnline/signal`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Small helper: fetch JSON, but if server returns HTML/blank we get a readable error
async function fetchJson(url, options) {
  const res = await fetch(url, { cache: "no-store", ...options });
  const text = await res.text();

  try {
    const j = JSON.parse(text);
    return { res, j };
  } catch {
    throw new Error(
      `Non-JSON response (HTTP ${res.status}) from ${url}. First 200 chars:\n${text.slice(0, 200)}`
    );
  }
}

async function createRoom() {
  const { j } = await fetchJson(`${SIGNAL_BASE}/create.php`);
  if (!j.ok) throw new Error(j.error || "createRoom failed");
  return j.code; // "123456"
}

async function putOffer(code, offerObj) {
  const body = new URLSearchParams({ code, offer: JSON.stringify(offerObj) });
  const { j } = await fetchJson(`${SIGNAL_BASE}/offer.php`, { method: "POST", body });
  if (!j.ok) throw new Error(j.error || "putOffer failed");
}

async function getOffer(code) {
  const { j } = await fetchJson(`${SIGNAL_BASE}/offer.php?code=${encodeURIComponent(code)}`);
  return j.offer ? JSON.parse(j.offer) : null;
}

async function putAnswer(code, answerObj) {
  const body = new URLSearchParams({ code, answer: JSON.stringify(answerObj) });
  const { j } = await fetchJson(`${SIGNAL_BASE}/answer.php`, { method: "POST", body });
  if (!j.ok) throw new Error(j.error || "putAnswer failed");
}

async function getAnswer(code) {
  const { j } = await fetchJson(`${SIGNAL_BASE}/answer.php?code=${encodeURIComponent(code)}`);
  return j.answer ? JSON.parse(j.answer) : null;
}

// Poll helper with a stop condition
async function pollUntil(getFn, shouldStopFn, intervalMs = 900) {
  while (!shouldStopFn()) {
    const val = await getFn();
    if (val) return val;
    await sleep(intervalMs);
  }
  return null;
}

async function setupNetwork() {
  // Reset per-session state
  globals.connected = false;
  globals.roomCode = null;
  globals._sentOffer = false;
  globals._sentAnswer = false;

  // UI setup
  const outBox = document.getElementById("outgoing");
  const inBox = document.getElementById("incoming");
  const copyBtn = document.getElementById("copyBtn");
  const connectBtn = document.getElementById("connectBtn");
  const status = document.getElementById("status-msg");

  copyBtn.disabled = true;
  outBox.value = "";
  // Don't clear guest's input automatically; it's annoying if they mistype.
  // inBox.value = "";

  // If host, create room code immediately so it can be shared
  if (globals.isHost) {
    try {
      globals.roomCode = await createRoom();
      outBox.value = globals.roomCode;
      copyBtn.disabled = false;
      status.textContent = `Room created. Share this code with your guest: ${globals.roomCode}`;
    } catch (e) {
      alert("Failed to create room code: " + e.message);
      status.textContent = "Failed to create room.";
      return;
    }
  } else {
    status.textContent = "Enter the 6-digit code from the host, then click Connect.";
  }
  if (globals.isHost) {
    // Host color selector
    const radios = document.querySelectorAll('input[name="hostColor"]');
    radios.forEach(r => {
        r.addEventListener("change", (e) => {
        const v = e.target.value;
        globals.myColor = (v === "white");
        globals.isWhiteView = globals.myColor;
        updateRoleTitle();
        });
    });
  }


  // Create peer
  try {
    globals.peer = new SimplePeer({
      initiator: globals.isHost,
      trickle: false,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:global.stun.twilio.com:3478" }
        ]
      }
    });
  } catch (e) {
    alert("Peer failed to start. Ensure you are using a modern browser (Chrome/Edge/Firefox).");
    status.textContent = "Peer failed to start.";
    return;
  }

  // Signaling: host uploads OFFER then polls for ANSWER; guest polls OFFER then uploads ANSWER
  globals.peer.on("signal", async (data) => {
    try {
      if (globals.isHost) {
        if (globals._sentOffer) return;
        globals._sentOffer = true;

        await putOffer(globals.roomCode, data);
        status.textContent = "Waiting for guest to join...";

        const ans = await pollUntil(
          () => getAnswer(globals.roomCode),
          () => globals.connected,
          900
        );

        if (ans && !globals.connected) {
          globals.peer.signal(ans);
          status.textContent = "Answer received. Connecting...";
        }
      } else {
        if (globals._sentAnswer) return;
        globals._sentAnswer = true;

        if (!globals.roomCode) {
          // This shouldn't happen if Connect button flow is followed
          throw new Error("Guest has no room code set. Enter code and click Connect first.");
        }

        await putAnswer(globals.roomCode, data);
        status.textContent = "Answer sent. Connecting...";
      }
    } catch (e) {
      alert("Signaling error: " + e.message);
      status.textContent = "Signaling error.";
    }
  });

    globals.peer.on("connect", () => {
    globals.connected = true;

    document.getElementById('connection-panel').style.display = 'none';
    document.getElementById('game-wrap').style.display = 'flex';

    // Host tells guest which color host chose
    if (globals.isHost) {
        globals.peer.send(JSON.stringify({ type: "meta", hostColor: globals.myColor }));

        // Host can start immediately
        initializeBoard();
        updateStatus();
    } else {
        // Guest waits for meta before starting (so orientation/color is correct)
        document.getElementById("turn-indicator").textContent = "Waiting for host settings...";
    }
    });


  globals.peer.on("data", (data) => {
    try {
      const msg = JSON.parse(data);
      handleNetworkMessage(msg);
    } catch (e) {
      console.error("Data error:", e);
    }
  });

  globals.peer.on("error", (err) => {
    console.error("SimplePeer Error:", err);
    if (err.code === "ERR_WEBRTC_SUPPORT") {
      alert("Your browser doesn't support WebRTC.");
    } else {
      alert("Connection Error: " + err.message + "\n\nPlease reload the page and try again.");
    }
  });

  // Copy room code (host)
  copyBtn.onclick = () => {
    outBox.select();
    document.execCommand("copy");
    copyBtn.textContent = "COPIED!";
    setTimeout(() => (copyBtn.textContent = "Copy Code"), 2000);
  };

  // Guest connect: poll for OFFER, then signal it
  connectBtn.onclick = async () => {
    if (globals.isHost) {
      alert("Host doesn't need to press Connect — just share the 6-digit code.");
      return;
    }

    const code = inBox.value.trim();
    if (!/^\d{6}$/.test(code)) {
      alert("Please enter a valid 6-digit room code.");
      return;
    }

    // Prevent spam-click starting multiple poll loops
    connectBtn.disabled = true;

    globals.roomCode = code;
    status.textContent = "Looking up room...";

    try {
      const offer = await pollUntil(
        () => getOffer(globals.roomCode),
        () => globals.connected,
        900
      );

      if (!offer) {
        // Stopped because connected (rare) or something else
        return;
      }

      status.textContent = "Offer received. Sending answer...";
      globals.peer.signal(offer);
    } catch (e) {
      alert("Failed to join room: " + e.message);
      status.textContent = "Failed to join room.";
      connectBtn.disabled = false;
    }
  };
}

async function deleteRoom(code) {
  const body = new URLSearchParams({ code });
  const res = await fetch(`${SIGNAL_BASE}/delete.php`, { method: "POST", body });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "deleteRoom failed");
  return j.deleted;
}

function updateRoleTitle() {
  const role = globals.isHost ? "HOST" : "GUEST";
  const color = globals.myColor ? "White" : "Black";
  document.getElementById("role-title").textContent = `${role} (${color})`;
}

function handleNetworkMessage(msg) {
    if (globals.gameOver) return;
    switch (msg.type) {
        case "meta":
            // msg.hostColor is true if host is White, false if host is Black
            // Guest is the opposite
            globals.myColor = !msg.hostColor;
            globals.isWhiteView = globals.myColor;
            updateRoleTitle();
            // Now start the game for guest
            initializeBoard();
            updateStatus();
            break;
        case 'move':
            tryMove(msg.to[0], msg.to[1], { 
                from: msg.from, 
                promotion: msg.promotion 
            });
            break;

        case 'resign':
            alert("Opponent Resigned! You Win!");
            globals.gameOver = true;
            break;
        case 'offer_draw':
            setTimeout(() => {
                const agree = confirm("Opponent offers a draw. Do you accept?");
                if (agree) {
                    globals.peer.send(JSON.stringify({ type: 'draw_accepted' }));
                    alert("Draw agreed!");
                    globals.gameOver = true;
                } else {
                    globals.peer.send(JSON.stringify({ type: 'draw_declined' }));
                }
            }, 100);
            break;
        case 'draw_accepted':
            alert("Opponent accepted the draw. Game Over.");
            globals.gameOver = true;
            resetDrawButton();
            break;
        case 'draw_declined':
            alert("Opponent declined the draw.");
            resetDrawButton();
            break;
    }
}

function resetDrawButton() {
    const btn = document.getElementById("drawBtn");
    if (btn) {
        btn.textContent = "Offer Draw";
        btn.disabled = false;
    }
}

const pieceName = { p: "pawn", r: "rook", n: "knight", b: "bishop", q: "queen", k: "king" };

async function initGame() {
    globals.isHost = location.hash === "#1";
    if (globals.isHost) {
        const checked = document.querySelector('input[name="hostColor"]:checked');
        globals.myColor = checked ? (checked.value === "white") : true;
    } else {
        globals.myColor = false;
    }
    globals.isWhiteView = globals.myColor;
    document.getElementById("host-panel").style.display = globals.isHost ? "block" : "none";
    document.getElementById("guest-panel").style.display = globals.isHost ? "none" : "block";
    updateRoleTitle();
    document.getElementById("status-msg").textContent = "Initializing Peer...";
    await setupNetwork();
    globals.turn = true;
    globals.boardState = [
        ["r", "n", "b", "q", "k", "b", "n", "r"],
        ["p", "p", "p", "p", "p", "p", "p", "p"],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        [null, null, null, null, null, null, null, null],
        ["P", "P", "P", "P", "P", "P", "P", "P"],
        ["R", "N", "B", "Q", "K", "B", "N", "R"],
    ];
    globals.castle = { wK: true, wQ: true, bK: true, bQ: true };
    globals.repetition = new Map();
    globals.halfMoveClock = 0;
    recordRepetition();
}

// Game Logic

function tryMove(toRow, toCol, remoteMove = null) {
    let fr, fc, promotionChoice;

    if (remoteMove) {
        fr = remoteMove.from[0];
        fc = remoteMove.from[1];
        promotionChoice = remoteMove.promotion;
    } else {
        if (!globals.selected) return false;
        if (!globals.selected.moves.some(([r, c]) => r === toRow && c === toCol)) return false;
        fr = globals.selected.row;
        fc = globals.selected.col;
        promotionChoice = null;
    }

    const moving = globals.boardState[fr][fc];
    const captured = globals.boardState[toRow][toCol];
    if (moving.toLowerCase() === 'p' || captured !== null) {
        globals.halfMoveClock = 0;
    } else {
        globals.halfMoveClock++;
    }

    const oldEP = globals.enPassant;
    globals.enPassant = null;

    // En Passant Capture
    if (moving && moving.toLowerCase() === "p" && oldEP && 
        toRow === oldEP.row && toCol === oldEP.col && fc !== toCol && 
        globals.boardState[toRow][toCol] === null) {
        globals.boardState[fr][toCol] = null;
    }

    // Castle Move
    const isCastle = moving && moving.toLowerCase() === "k" && Math.abs(toCol - fc) === 2;
    if (isCastle) {
        const r = fr;
        if (toCol === 6) { globals.boardState[r][5] = globals.boardState[r][7]; globals.boardState[r][7] = null; }
        else if (toCol === 2) { globals.boardState[r][3] = globals.boardState[r][0]; globals.boardState[r][0] = null; }
    }

    // Set En Passant Flag
    if (moving && moving.toLowerCase() === "p" && Math.abs(toRow - fr) === 2) {
        globals.enPassant = { row: (fr + toRow) / 2, col: fc };
    }

    // Promotion
    let placed = moving;
    if (moving && moving.toLowerCase() === "p" && (toRow === 0 || toRow === 7)) {
        let ch;
        if (remoteMove) ch = promotionChoice;
        else ch = promoteChoice();
        placed = (moving === "P") ? ch.toUpperCase() : ch;
    }

    // Castle Rights Update
    if (moving && moving.toLowerCase() === "k") {
        if (moving === "K") { globals.castle.wK = false; globals.castle.wQ = false; }
        else { globals.castle.bK = false; globals.castle.bQ = false; }
    }
    if (moving && moving.toLowerCase() === "r") {
        if (moving === "R") {
            if (fr === 7 && fc === 0) globals.castle.wQ = false;
            if (fr === 7 && fc === 7) globals.castle.wK = false;
        } else {
            if (fr === 0 && fc === 0) globals.castle.bQ = false;
            if (fr === 0 && fc === 7) globals.castle.bK = false;
        }
    }
    if (captured && captured.toLowerCase() === "r") {
        if (captured === "R") {
            if (toRow === 7 && toCol === 0) globals.castle.wQ = false;
            if (toRow === 7 && toCol === 7) globals.castle.wK = false;
        } else {
            if (toRow === 0 && toCol === 0) globals.castle.bQ = false;
            if (toRow === 0 && toCol === 7) globals.castle.bK = false;
        }
    }
    globals.boardState[toRow][toCol] = placed;
    globals.boardState[fr][fc] = null;
    globals.turn = !globals.turn;
    if (!remoteMove && globals.connected) {
        const payload = {
            type: 'move',
            from: [fr, fc],
            to: [toRow, toCol],
            promotion: placed.toLowerCase()
        };
        globals.peer.send(JSON.stringify(payload));
    }
    drawBoard();
    updateStatus();
    checkGameOver();
    return true;
}

function updateStatus() {
    const ind = document.getElementById("turn-indicator");
    if (!ind) return;
    const turnText = globals.turn ? "White's Turn" : "Black's Turn";
    ind.textContent = `${turnText} ${globals.turn === globals.myColor ? "YOUR TURN" : "WAITING..."}`;
    ind.style.color = globals.turn === globals.myColor ? "green" : "black";
}

function setupUI() {
    const resignBtn = document.getElementById("resignBtn");
    if (resignBtn) {
        resignBtn.addEventListener("click", () => {
            if (!globals.connected || globals.gameOver) return;
            if (confirm("Are you sure you want to resign?")) {
                globals.peer.send(JSON.stringify({ type: 'resign' }));
                alert("You resigned. You lose.");
                globals.gameOver = true;
            }
        });
    }
    const drawBtn = document.getElementById("drawBtn");
    if (drawBtn) {
        drawBtn.addEventListener("click", () => {
            if (!globals.connected || globals.gameOver) return;
            globals.peer.send(JSON.stringify({ type: 'offer_draw' }));
            drawBtn.textContent = "Offer Sent...";
            drawBtn.disabled = true;
            setTimeout(() => {
                if(!globals.gameOver) {
                    drawBtn.textContent = "Offer Draw";
                    drawBtn.disabled = false;
                }
            }, 5000);
        });
    }
}

function cloneBoard(board) { return board.map(row => row.slice()); }

function findKing(board, isWhite) {
    const k = isWhite ? "K" : "k";
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (board[r][c] === k) return [r, c];
    return null;
}

function positionKey() {
    let boardStr = "";
    for (let r = 0; r < 8; r++) { for (let c = 0; c < 8; c++) boardStr += globals.boardState[r][c] || "."; boardStr += "/"; }
    const turnStr = globals.turn ? "w" : "b";
    let cast = "";
    if (globals.castle.wK) cast += "K"; if (globals.castle.wQ) cast += "Q";
    if (globals.castle.bK) cast += "k"; if (globals.castle.bQ) cast += "q";
    if (cast === "") cast = "-";
    let ep = "-";
    if (globals.enPassant && enPassantCaptureIsPossible()) ep = `${globals.enPassant.row},${globals.enPassant.col}`;
    return `${boardStr} ${turnStr} ${cast} ${ep}`;
}

function enPassantCaptureIsPossible() {
    const ep = globals.enPassant;
    if (!ep) return false;
    const dir = globals.turn ? -1 : 1;
    const pawn = globals.turn ? "P" : "p";
    const r = ep.row - dir;
    for (const dc of [-1, 1]) {
        const c = ep.col + dc;
        if (inBounds(r, c) && globals.boardState[r][c] === pawn) return true;
    }
    return false;
}

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function isUpper(ch) { return ch === ch.toUpperCase(); }
function isEnemy(color, pieceChar) { return color !== isUpper(pieceChar); }
function viewToBoard(viewRow, viewCol) { return globals.isWhiteView ? [viewRow, viewCol] : [7 - viewRow, 7 - viewCol]; }
function boardToView(boardRow, boardCol) { return globals.isWhiteView ? [boardRow, boardCol] : [7 - boardRow, 7 - boardCol]; }

function promoteChoice() {
    const input = prompt("Promote to (q, r, b, n):", "q");
    const c = (input || "q").toLowerCase();
    return ["q", "r", "b", "n"].includes(c) ? c : "q";
}

function handleDragStart(e, pieceType, color, r, c) {
    if (globals.turn !== globals.myColor || globals.turn !== color) {
        e.preventDefault();
        return;
    }
    globals.selected = null; 
    onPieceClick(pieceType, color, r, c); 
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", JSON.stringify({ r, c }));
    setTimeout(() => {
        e.target.classList.add('dragging');
    }, 0);
}

function handleDragEnd(e) {
    e.target.classList.remove('dragging');
}

function handleDrop(e, r, c) {
    e.preventDefault();
    if (globals.selected) {
        tryMove(r, c);
    }
}

// RENDERING
function initializeBoard() {
    const boardEl = document.getElementById("board");
    boardEl.innerHTML = "";
    for (let viewRow = 0; viewRow < globals.boardLength; viewRow++) {
        for (let viewCol = 0; viewCol < globals.boardLength; viewCol++) {
            const [r, c] = viewToBoard(viewRow, viewCol);
            const square = document.createElement("div");
            square.className = "square " + ((viewRow + viewCol) % 2 === 0 ? "light" : "dark");
            square.addEventListener("click", () => onSquareClick(r, c));
            square.addEventListener("dragover", (e) => {
                e.preventDefault(); 
                e.dataTransfer.dropEffect = "move";
            });
            square.addEventListener("drop", (e) => handleDrop(e, r, c));
            if (globals.boardState[r][c]) {
                square.appendChild(createPieceImg(globals.boardState[r][c], r, c));
            }
            boardEl.appendChild(square);
        }
    }
}

function drawBoard() {
    clearHighlights();
    globals.selected = null;
    const squares = document.getElementsByClassName("square");
    for (let viewRow = 0; viewRow < globals.boardLength; viewRow++) {
        for (let viewCol = 0; viewCol < globals.boardLength; viewCol++) {
            const index = (viewRow * globals.boardLength) + viewCol;
            const squareEl = squares[index];
            squareEl.innerHTML = "";
            const [r, c] = viewToBoard(viewRow, viewCol);
            if (globals.boardState[r][c]) {
                squareEl.appendChild(createPieceImg(globals.boardState[r][c], r, c));
            }
        }
    }
}

function createPieceImg(pieceChar, r, c) {
    const pieceType = pieceChar.toLowerCase();
    const isWhitePiece = isUpper(pieceChar);
    const img = document.createElement("img");
    img.classList.add("piece");
    img.draggable = true; 
    img.src = `pieces/${pieceName[pieceType]}-${isWhitePiece ? "w" : "b"}.svg`;
        img.addEventListener("click", (e) => {
        e.stopPropagation();
        onPieceClick(pieceType, isWhitePiece, r, c);
    });
    img.addEventListener("dragstart", (e) => handleDragStart(e, pieceType, isWhitePiece, r, c));
    img.addEventListener("dragend", handleDragEnd);
    return img;
}

function onPieceClick(pieceType, color, row, col) {
    if (globals.selected) {
        if (tryMove(row, col)) return;
    }
    if (globals.myColor !== color) return; 
    if (globals.turn !== color) return;
    const moves = getLegalMoves(pieceType, color, row, col);
    globals.selected = { row, col, moves };
    highlightMoves(moves);
}

function onSquareClick(row, col) {
    if (globals.turn !== globals.myColor) return;
    tryMove(row, col);
}

function highlightMoves(moves) {
    clearHighlights();
    const squares = document.getElementsByClassName("square");
        if (globals.selected) {
        const [vr, vc] = boardToView(globals.selected.row, globals.selected.col);
        const index = (vr * globals.boardLength) + vc;
        squares[index].classList.add("selected");
    }
    for (let i = 0; i < moves.length; i++) {
        const [r, c] = moves[i];
        const [vr, vc] = boardToView(r, c);
        const index = (vr * globals.boardLength) + vc;
        squares[index].classList.add("move-dot");
    }
}

function clearHighlights() {
    const squares = document.getElementsByClassName("square");
    for (let i = 0; i < squares.length; i++) {
        squares[i].classList.remove("move-dot");
        squares[i].classList.remove("selected");
    }
}

function recordRepetition() {
    const key = positionKey();
    const prev = globals.repetition.get(key) || 0;
    const next = prev + 1;
    globals.repetition.set(key, next);
    return next;
}

function checkGameOver() {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (globals.halfMoveClock >= 100) { alert("Draw by 50-move rule!"); return; }
            if (isInsufficientMaterial()) { alert("Draw by insufficient material!"); return; }
            const repCount = recordRepetition();
            if (repCount >= 3) { alert("Threefold repetition! Draw."); return; }
            const endState = getEndStateForSideToMove();
            if (endState === "checkmate") {
                alert(`Checkmate! ${globals.turn ? "White" : "Black"} is checkmated.`);
            } else if (endState === "stalemate") {
                alert("Stalemate! Draw.");
            }
        });
    });
}

function isInsufficientMaterial() {
    let wMinors = 0, bMinors = 0, others = 0;
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const p = globals.boardState[r][c];
            if (!p) continue;
            const type = p.toLowerCase();
            if (type === 'k') continue; 
            if (type === 'n' || type === 'b') {
                if (isUpper(p)) wMinors++; else bMinors++;
            } else {
                others++;
            }
        }
    }
    if (others > 0) return false;
    const totalMinors = wMinors + bMinors;
    if (totalMinors === 0) return true; 
    if (totalMinors === 1) return true; 
    if (wMinors === 1 && bMinors === 1) return true; 
    return false;
}

function getEndStateForSideToMove() {
  const sideToMove = globals.turn;
  const inCheck = isInCheck(sideToMove);
  const hasMove = sideHasAnyLegalMove(sideToMove);
  if (!hasMove && inCheck) return "checkmate";
  if (!hasMove && !inCheck) return "stalemate";
  return null;
}

function getLegalMoves(pieceType, color, row, col) {
    let moves = [];
    switch (pieceType) {
        case "p": moves = getPawnMoves(color, row, col); break;
        case "n": moves = getKnightMoves(color, row, col); break;
        case "b": moves = getBishopMoves(color, row, col); break;
        case "r": moves = getRookMoves(color, row, col); break;
        case "q": moves = getQueenMoves(color, row, col); break;
        case "k": moves = getKingMoves(color, row, col); break;
        default: return [];
    }
    return moves.filter(([tr, tc]) => !wouldLeaveKingInCheck(color, row, col, tr, tc));
}

function wouldLeaveKingInCheck(color, fr, fc, tr, tc) {
    const movingPiece = globals.boardState[fr][fc];
    const oldEP = globals.enPassant;
    const next = applyMove(globals.boardState, fr, fc, tr, tc, movingPiece, oldEP);
    const saved = globals.boardState;
    globals.boardState = next;
    const kingPos = findKing(next, color);
    const inCheck = kingPos ? isSquareAttacked(next, kingPos[0], kingPos[1], !color) : true;
    globals.boardState = saved;
    return inCheck;
}

function isInCheck(color) {
    const kingPos = findKing(globals.boardState, color);
    if (!kingPos) return true;
    return isSquareAttacked(globals.boardState, kingPos[0], kingPos[1], !color);
}

function sideHasAnyLegalMove(color) {
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const p = globals.boardState[r][c];
            if (!p) continue;
            if (isUpper(p) !== color) continue;
            const type = p.toLowerCase();
            if (getLegalMoves(type, color, r, c).length > 0) return true;
        }
    }
    return false;
}

function isSquareAttacked(board, targetRow, targetCol, byWhite) {
    for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
            const p = board[r][c];
            if (!p) continue;
            if (isUpper(p) !== byWhite) continue;
            const type = p.toLowerCase();
            if (type === "p") {
                const dir = byWhite ? -1 : 1;
                for (const dc of [-1, 1]) {
                    const rr = r + dir;
                    const cc = c + dc;
                    if (rr === targetRow && cc === targetCol) return true;
                }
                continue;
            }
            let moves = [];
            if (type === "n") moves = getKnightMoves(byWhite, r, c);
            else if (type === "b") moves = getBishopMoves(byWhite, r, c);
            else if (type === "r") moves = getRookMoves(byWhite, r, c);
            else if (type === "q") moves = getQueenMoves(byWhite, r, c);
            else if (type === "k") moves = getKingMovesNoCastle(byWhite, r, c);
            for (let i = 0; i < moves.length; i++) {
                if (moves[i][0] === targetRow && moves[i][1] === targetCol) return true;
            }
        }
    }
    return false;
}

function getPawnMoves(color, row, col) {
    const moves = [];
    const dir = color ? -1 : 1;
    const startRow = color ? 6 : 1;
    if (inBounds(row + dir, col) && globals.boardState[row + dir][col] === null) {
        moves.push([row + dir, col]);
        if (row === startRow && inBounds(row + 2 * dir, col) && globals.boardState[row + 2 * dir][col] === null) {
            moves.push([row + 2 * dir, col]);
        }
    }
    for (const dc of [-1, 1]) {
        const r = row + dir, c = col + dc;
        if (!inBounds(r, c)) continue;
        const target = globals.boardState[r][c];
        if (target !== null && isEnemy(color, target)) moves.push([r, c]);
    }
    if (globals.enPassant) {
        const epRow = globals.enPassant.row, epCol = globals.enPassant.col;
        if (epRow === row + dir && Math.abs(epCol - col) === 1) {
            const victim = globals.boardState[row][epCol];
            if (victim && victim.toLowerCase() === "p" && isEnemy(color, victim)) moves.push([epRow, epCol]);
        }
    }
    return moves;
}

function getKnightMoves(color, row, col) {
    const moves = [];
    const deltas = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (const [dr, dc] of deltas) {
        const r = row + dr, c = col + dc;
        if (inBounds(r, c) && (globals.boardState[r][c] === null || isEnemy(color, globals.boardState[r][c]))) moves.push([r, c]);
    }
    return moves;
}

function getSlidingMoves(color, row, col, directions) {
    const moves = [];
    for (let i = 0; i < directions.length; i++) {
        const dr = directions[i][0], dc = directions[i][1];
        let r = row + dr, c = col + dc;
        while (inBounds(r, c)) {
            const target = globals.boardState[r][c];
            if (target === null) { moves.push([r, c]); } 
            else { if (isEnemy(color, target)) moves.push([r, c]); break; }
            r += dr; c += dc;
        }
    }
    return moves;
}

function getBishopMoves(color, row, col) { return getSlidingMoves(color, row, col, [[1, 1], [1, -1], [-1, 1], [-1, -1]]); }
function getRookMoves(color, row, col) { return getSlidingMoves(color, row, col, [[1, 0], [-1, 0], [0, 1], [0, -1]]); }
function getQueenMoves(color, row, col) { return getSlidingMoves(color, row, col, [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]); }

function getKingMoves(color, row, col) {
    const moves = getKingMovesNoCastle(color, row, col);
    const isWhite = color, homeRow = isWhite ? 7 : 0;
    if (row !== homeRow || col !== 4) return moves;
    const enemyColor = !isWhite;
    if (isSquareAttacked(globals.boardState, homeRow, 4, enemyColor)) return moves;
    if (isWhite ? globals.castle.wK : globals.castle.bK) {
        if (globals.boardState[homeRow][5] === null && globals.boardState[homeRow][6] === null) {
            if (!isSquareAttacked(globals.boardState, homeRow, 5, enemyColor) && !isSquareAttacked(globals.boardState, homeRow, 6, enemyColor)) {
                if (globals.boardState[homeRow][7] === (isWhite ? "R" : "r")) moves.push([homeRow, 6]);
            }
        }
    }
    if (isWhite ? globals.castle.wQ : globals.castle.bQ) {
        if (globals.boardState[homeRow][1] === null && globals.boardState[homeRow][2] === null && globals.boardState[homeRow][3] === null) {
            if (!isSquareAttacked(globals.boardState, homeRow, 3, enemyColor) && !isSquareAttacked(globals.boardState, homeRow, 2, enemyColor)) {
                if (globals.boardState[homeRow][0] === (isWhite ? "R" : "r")) moves.push([homeRow, 2]);
            }
        }
    }
    return moves;
}

function getKingMovesNoCastle(color, row, col) {
    const moves = [];
    for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            const r = row + dr, c = col + dc;
            if (inBounds(r, c) && (globals.boardState[r][c] === null || isEnemy(color, globals.boardState[r][c]))) moves.push([r, c]);
        }
    }
    return moves;
}

function applyMove(board, fr, fc, tr, tc, movingPiece, oldEP) {
    const b = cloneBoard(board);
    const piece = movingPiece ?? b[fr][fc];
    if (piece && piece.toLowerCase() === "p" && oldEP && tr === oldEP.row && tc === oldEP.col && fc !== tc && b[tr][tc] === null) b[fr][tc] = null;
    if (piece && piece.toLowerCase() === "k" && Math.abs(tc - fc) === 2) {
        if (tc === 6) { b[fr][5] = b[fr][7]; b[fr][7] = null; }
        else if (tc === 2) { b[fr][3] = b[fr][0]; b[fr][0] = null; }
    }
    b[tr][tc] = piece;
    b[fr][fc] = null;
    return b;
}

window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled rejection reason:", e.reason);
});

function bootFail(msg, err) {
  const el = document.getElementById("status-msg");
  if (el) el.textContent = msg;
  console.error(msg, err || "");
  alert(msg);
}

window.addEventListener("DOMContentLoaded", () => {
  console.log("✅ script.js loaded");

  // If SimplePeer didn't load, nothing will work
  if (typeof SimplePeer === "undefined") {
    bootFail("SimplePeer failed to load (CDN blocked or script tag missing).", null);
    return;
  }

  try {
    setupUI();

    initGame().catch((e) => {
      bootFail("initGame failed: " + (e?.message || e), e);
    });
  } catch (e) {
    bootFail("Startup error: " + (e?.message || e), e);
  }
});
