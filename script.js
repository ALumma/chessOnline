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
    connected: false
};

const pieceName = { p: "pawn", r: "rook", n: "knight", b: "bishop", q: "queen", k: "king" };

function initGame() {
    globals.isHost = location.hash === '#1';
    globals.myColor = globals.isHost; // Host is White
    globals.isWhiteView = globals.myColor;
    document.getElementById("role-title").textContent = globals.isHost ? "HOST (White)" : "GUEST (Black)";
    document.getElementById("status-msg").textContent = "Initializing Peer...";
    setupNetwork();
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

function setupNetwork() {
    try {
        globals.peer = new SimplePeer({ 
            initiator: globals.isHost, 
            trickle: false,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ]
            }
        });
    } catch (e) {
        alert("Peer failed to start. Ensure you are using a modern browser (Chrome/Edge/Firefox).");
        return;
    }

    globals.peer.on('signal', data => {
        const json = JSON.stringify(data);
        const code = btoa(json);         
        const outBox = document.getElementById('outgoing');
        outBox.value = code;
        document.getElementById('copyBtn').disabled = false;
        if (globals.isHost) {
            document.getElementById('status-msg').textContent = "STEP 1: Copy YOUR CODE and send to Guest.";
        } else {
            document.getElementById('status-msg').textContent = "STEP 2: Copy YOUR CODE and send back to Host.";
        }
    });

    globals.peer.on('connect', () => {
        globals.connected = true;
        document.getElementById('connection-panel').style.display = 'none';
        document.getElementById('game-wrap').style.display = 'flex';
        alert("🟢 P2P Connection Established!\n\nGame is starting.");
        
        initializeBoard();
        updateStatus();
    });

    globals.peer.on('data', data => {
        try {
            const msg = JSON.parse(data);
            handleNetworkMessage(msg);
        } catch (e) {
            console.error("Data error:", e);
        }
    });

    globals.peer.on('error', err => {
        console.error("SimplePeer Error:", err);
        if (err.code === 'ERR_WEBRTC_SUPPORT') {
            alert("Your browser doesn't support WebRTC.");
        } else if (err.code === 'ERR_DATA_CHANNEL') {
        } else {
            alert("Connection Error: " + err.message + "\n\nPlease reload the page and try again.");
        }
    });

    document.getElementById('copyBtn').onclick = () => {
        const outBox = document.getElementById('outgoing');
        outBox.select();
        document.execCommand('copy');
        document.getElementById('copyBtn').textContent = "COPIED!";
        setTimeout(() => document.getElementById('copyBtn').textContent = "Copy Code", 2000);
    };

    document.getElementById('connectBtn').onclick = () => {
        const inBox = document.getElementById('incoming');
        const codeStr = inBox.value.trim();
        
        if (!codeStr) {
            alert("Please paste the opponent's code first.");
            return;
        }
        
        try {
            const json = atob(codeStr);
            const signalData = JSON.parse(json);
            
            document.getElementById('status-msg').textContent = "Connecting... Please wait.";
            globals.peer.signal(signalData);
        } catch (e) {
            alert("Invalid Code!\n\nPlease make sure you copied the ENTIRE code string.");
        }
    };
}

function handleNetworkMessage(msg) {
    if (globals.gameOver) return;
    switch (msg.type) {
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

setupUI();
initGame();