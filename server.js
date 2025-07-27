// server/server.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: "https://kahoot-cli.netlify.app/",
        methods: ["GET", "POST"]
    }
});

app.use(cors());

const PORT = process.env.PORT || 5000;

// Khởi tạo questionSets rỗng hoặc với một cấu trúc mẫu ban đầu
// Nó sẽ được ghi đè khi admin upload file JSON
let questionSets = []; // Sẽ chỉ chứa 1 bộ câu hỏi được tải lên

const ADMIN_PASSWORD = 'namvuong0509';

let gameSession = {
    status: 'waiting',
    currentQuestionSetId: null,
    currentQuestionIndex: -1,
    currentQuestion: null,
    questionStartTime: null,
    questionEndTime: null,
    players: [],
    adminLeaderboard: [], // Stores all players including disconnected ones for admin view
    timer: null, // Timer for question duration
    countdownTimer: null, // Timer for 3-second countdown
    questionDisplayTimer: null // Timer for 5-second question display
};

io.on('connection', (socket) => {
    console.log(`Người chơi/Admin mới kết nối: ${socket.id}`);

    // Gửi trạng thái game hiện tại cho người chơi/admin mới kết nối
    socket.emit('game-state', {
        status: gameSession.status,
        currentQuestionSetId: gameSession.currentQuestionSetId,
        currentQuestion: gameSession.currentQuestion ? {
            id: gameSession.currentQuestion.id,
            questionText: gameSession.currentQuestion.questionText,
            options: gameSession.status === 'playing' ? gameSession.currentQuestion.options : []
        } : null,
        players: gameSession.players.map(p => ({ id: p.id, nickname: p.nickname, avatarId: p.avatarId, score: p.score, connected: p.connected })),
        leaderboard: calculateCurrentLeaderboard(),
        // Chỉ gửi bộ câu hỏi hiện đang được tải (nếu có)
        questionSets: questionSets.length > 0 ? [{ id: questionSets[0].id, name: questionSets[0].name }] : [],
        adminLeaderboard: gameSession.adminLeaderboard,
        timeRemaining: getTimeRemaining()
    });

    socket.on('player-join', (data, callback) => {
        const { nickname, avatarId } = data;

        if (gameSession.players.some(p => p.connected && p.nickname.toLowerCase() === nickname.toLowerCase())) {
            console.log(`Người chơi ${nickname} đã tồn tại và đang kết nối.`);
            return callback({ success: false, message: 'Nickname đã tồn tại và đang hoạt động. Vui lòng chọn tên khác.' });
        }

        const existingDisconnectedPlayerIndex = gameSession.players.findIndex(p => !p.connected && p.nickname.toLowerCase() === nickname.toLowerCase());
        if (existingDisconnectedPlayerIndex !== -1) {
            const existingPlayer = gameSession.players[existingDisconnectedPlayerIndex];
            existingPlayer.id = socket.id;
            existingPlayer.connected = true;
            existingPlayer.avatarId = avatarId;
            gameSession.players = [...gameSession.players.filter((_, i) => i !== existingDisconnectedPlayerIndex), existingPlayer];
            console.log(`Người chơi ${nickname} (${socket.id}) đã kết nối lại.`);
        } else {
            const newPlayer = {
                id: socket.id,
                nickname,
                avatarId,
                score: 0,
                answers: {},
                connected: true
            };
            gameSession.players.push(newPlayer);
            console.log(`Người chơi ${nickname} (${socket.id}) đã tham gia.`);
        }

        io.emit('player-list-update', gameSession.players.map(p => ({ id: p.id, nickname: p.nickname, avatarId: p.avatarId, score: p.score, connected: p.connected })));
        io.emit('leaderboard-update', calculateCurrentLeaderboard());

        callback({ success: true, message: 'Tham gia thành công!' });
    });

    socket.on('submit-answer', (data) => {
        const { questionId, answerId } = data;
        const player = gameSession.players.find(p => p.id === socket.id);

        if (!player || gameSession.status !== 'playing' || !gameSession.currentQuestion || gameSession.currentQuestion.id !== questionId) {
            console.log("Câu trả lời không hợp lệ hoặc game chưa ở trạng thái chơi.");
            return;
        }

        if (player.answers[questionId]) {
            console.log(`${player.nickname} đã trả lời câu này rồi.`);
            return;
        }

        const question = getCurrentQuestionSet()?.questions.find(q => q.id === questionId);
        if (!question) return;

        const timeTaken = (Date.now() - gameSession.questionStartTime) / 1000;
        let points = 0;

        if (answerId === question.correctAnswerId) {
            points = Math.max(0, Math.round(1000 - (timeTaken / question.defaultTimeLimit) * 800));
            player.score += points;
            console.log(`${player.nickname} trả lời ĐÚNG! +${points} điểm. Tổng: ${player.score}`);
        } else {
            console.log(`${player.nickname} trả lời SAI.`);
        }

        player.answers[questionId] = { answerId, isCorrect: (answerId === question.correctAnswerId), pointsEarned: points };

        socket.emit('answer-feedback', {
            isCorrect: (answerId === question.correctAnswerId),
            yourScore: player.score,
            pointsEarned: points
        });

        const connectedPlayers = gameSession.players.filter(p => p.connected);
        const allAnswered = connectedPlayers.every(p => p.answers[questionId]);

        if (allAnswered && gameSession.status === 'playing') {
            console.log('Tất cả người chơi đã trả lời. Kết thúc câu hỏi sớm.');
            clearTimeout(gameSession.timer);
            handleQuestionEnd();
        }
    });

    // --- Admin Events ---
    socket.on('admin-auth', (password, callback) => {
        if (password === ADMIN_PASSWORD) {
            console.log(`Admin (${socket.id}) đã xác thực thành công.`);
            socket.is_admin = true;
            callback({ success: true, message: 'Xác thực Admin thành công!' });
        } else {
            console.log(`Admin (${socket.id}) xác thực thất bại.`);
            callback({ success: false, message: 'Sai mật khẩu Admin.' });
        }
    });

    // MỚI: Sự kiện để Admin tải lên bộ câu hỏi từ file JSON
    socket.on('admin-upload-question-set', (jsonData, callback) => {
        if (!socket.is_admin) return callback({ success: false, message: 'Unauthorized' });

        try {
            const newSet = JSON.parse(jsonData);

            // Kiểm tra cấu trúc cơ bản của bộ câu hỏi
            if (!newSet.id || !newSet.name || !Array.isArray(newSet.questions)) {
                return callback({ success: false, message: 'Cấu trúc file JSON không hợp lệ. Thiếu id, name hoặc questions.' });
            }
            if (newSet.questions.length === 0) {
                return callback({ success: false, message: 'Bộ câu hỏi không có câu hỏi nào.' });
            }

            // Kiểm tra cấu trúc từng câu hỏi
            for (const q of newSet.questions) {
                if (!q.id || !q.questionText || !Array.isArray(q.options) || q.options.length < 2 || !q.correctAnswerId || !q.defaultTimeLimit || q.defaultTimeLimit < 5) {
                    return callback({ success: false, message: `Câu hỏi "${q.questionText || 'không tên'}" có cấu trúc không hợp lệ hoặc thiếu thông tin.` });
                }
                for (const opt of q.options) {
                    if (!opt.id || !opt.text) {
                        return callback({ success: false, message: `Lựa chọn trong câu hỏi "${q.questionText}" có cấu trúc không hợp lệ.` });
                    }
                }
                if (!q.options.some(opt => opt.id === q.correctAnswerId)) {
                    return callback({ success: false, message: `Đáp án đúng cho câu hỏi "${q.questionText}" không khớp với bất kỳ lựa chọn nào.` });
                }
            }

            questionSets = [newSet]; // Thay thế bộ câu hỏi hiện tại bằng bộ mới
            gameSession.currentQuestionSetId = newSet.id; // Tự động chọn bộ câu hỏi này
            gameSession.status = 'waiting';
            gameSession.currentQuestionIndex = -1;
            gameSession.currentQuestion = null;
            gameSession.players.forEach(p => { p.score = 0; p.answers = {}; });
            gameSession.adminLeaderboard = [];
            clearGameTimers();

            io.emit('game-state', {
                status: gameSession.status,
                currentQuestionSetId: gameSession.currentQuestionSetId,
                currentQuestion: null,
                players: gameSession.players.map(p => ({ id: p.id, nickname: p.nickname, avatarId: p.avatarId, score: p.score, connected: p.connected })),
                leaderboard: [],
                questionSets: [{ id: newSet.id, name: newSet.name }], // Gửi thông tin bộ câu hỏi mới cho client
                adminLeaderboard: gameSession.adminLeaderboard
            });
            console.log(`Admin đã tải lên và chọn bộ câu hỏi: ${newSet.name}`);
            callback({ success: true, message: `Bộ câu hỏi "${newSet.name}" đã được tải lên và chọn thành công.` });

        } catch (error) {
            console.error('Lỗi khi xử lý file JSON:', error);
            callback({ success: false, message: 'Lỗi khi đọc file JSON. Đảm bảo đây là file JSON hợp lệ và đúng định dạng.' });
        }
    });

    // Sự kiện chọn bộ câu hỏi (giờ chỉ cần xác nhận bộ đã tải)
    socket.on('admin-select-question-set', (setId) => {
        if (!socket.is_admin) return;
        // Logic này giờ đơn giản hơn vì chỉ có một bộ câu hỏi (hoặc không có)
        const selectedSet = questionSets.find(set => set.id === setId);
        if (selectedSet) {
            gameSession.currentQuestionSetId = setId;
            gameSession.status = 'waiting';
            gameSession.currentQuestionIndex = -1;
            gameSession.currentQuestion = null;
            gameSession.players.forEach(p => { p.score = 0; p.answers = {}; });
            gameSession.adminLeaderboard = [];
            clearGameTimers();
            io.emit('game-state', {
                status: gameSession.status,
                currentQuestionSetId: gameSession.currentQuestionSetId,
                currentQuestion: null,
                players: gameSession.players.map(p => ({ id: p.id, nickname: p.nickname, avatarId: p.avatarId, score: p.score, connected: p.connected })),
                leaderboard: [],
                questionSets: questionSets.length > 0 ? [{ id: questionSets[0].id, name: questionSets[0].name }] : [],
                adminLeaderboard: gameSession.adminLeaderboard
            });
            console.log(`Admin đã chọn bộ câu hỏi: ${selectedSet.name}`);
            io.to(socket.id).emit('admin-message', `Đã chọn bộ câu hỏi: ${selectedSet.name}`);
        } else {
            io.to(socket.id).emit('admin-message', 'Bộ câu hỏi không tồn tại.');
        }
    });

    socket.on('admin-start-game', () => {
        if (!socket.is_admin || gameSession.status === 'playing' || !gameSession.currentQuestionSetId) return;
        const currentQuestionSet = getCurrentQuestionSet();
        if (!currentQuestionSet || currentQuestionSet.questions.length === 0) {
            console.log("Không có câu hỏi trong bộ được chọn.");
            io.to(socket.id).emit('admin-message', 'Không có câu hỏi trong bộ được chọn để bắt đầu game.');
            return;
        }

        gameSession.status = 'playing';
        gameSession.currentQuestionIndex = -1;
        gameSession.players.forEach(p => {
            p.score = 0;
            p.answers = {};
        });
        clearGameTimers();
        gameSession.adminLeaderboard = []; // Reset leaderboard for new game

        io.emit('game-started');
        io.emit('player-list-update', gameSession.players.map(p => ({ id: p.id, nickname: p.nickname, avatarId: p.avatarId, score: p.score, connected: p.connected })));
        io.emit('leaderboard-update', calculateCurrentLeaderboard());
        console.log("Admin đã bắt đầu trò chơi. Chuyển đến câu hỏi đầu tiên.");

        moveToNextQuestion();
    });

    socket.on('admin-end-game', () => {
        if (!socket.is_admin) return;
        endGame();
    });

    // Xóa các sự kiện admin-add-question-set và admin-add-question

    socket.on('admin-get-leaderboard', (callback) => {
        if (!socket.is_admin) return;
        callback(gameSession.adminLeaderboard);
    });

    socket.on('disconnect', () => {
        console.log(`Người chơi/Admin ngắt kết nối: ${socket.id}`);
        const playerIndex = gameSession.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== -1) {
            gameSession.players[playerIndex].connected = false;
            const disconnectedPlayer = { ...gameSession.players[playerIndex], disconnectedAt: Date.now(), connected: false };
            const existingAdminLbIndex = gameSession.adminLeaderboard.findIndex(p => p.nickname === disconnectedPlayer.nickname);
            if (existingAdminLbIndex !== -1) {
                gameSession.adminLeaderboard[existingAdminLbIndex] = disconnectedPlayer;
            } else {
                gameSession.adminLeaderboard.push(disconnectedPlayer);
            }
            console.log(`Người chơi ${gameSession.players[playerIndex].nickname} đã ngắt kết nối.`);

            io.emit('player-list-update', gameSession.players.map(p => ({ id: p.id, nickname: p.nickname, avatarId: p.avatarId, score: p.score, connected: p.connected })));
            io.emit('admin-leaderboard-update', gameSession.adminLeaderboard.map(p => ({ nickname: p.nickname, score: p.score, avatarId: p.avatarId, connected: p.connected })));
        }
        io.emit('leaderboard-update', calculateCurrentLeaderboard());
    });
});

// --- Helper Functions ---
function clearGameTimers() {
    if (gameSession.timer) {
        clearTimeout(gameSession.timer);
        gameSession.timer = null;
    }
    if (gameSession.countdownTimer) {
        clearInterval(gameSession.countdownTimer);
        gameSession.countdownTimer = null;
    }
    if (gameSession.questionDisplayTimer) {
        clearTimeout(gameSession.questionDisplayTimer);
        gameSession.questionDisplayTimer = null;
    }
}

function getCurrentQuestionSet() {
    // Vì questionSets giờ chỉ chứa một bộ, ta lấy nó trực tiếp
    return questionSets.length > 0 ? questionSets[0] : null;
}

function calculateCurrentLeaderboard() {
    return gameSession.players
        .filter(p => p.connected)
        .slice()
        .sort((a, b) => b.score - a.score)
        .map(p => ({ nickname: p.nickname, score: p.score, avatarId: p.avatarId }));
}

function getTimeRemaining() {
    if (gameSession.status === 'playing' && gameSession.questionEndTime) {
        const remaining = Math.max(0, Math.ceil((gameSession.questionEndTime - Date.now()) / 1000));
        return remaining;
    }
    return 0;
}

function moveToNextQuestion() {
    clearGameTimers();
    gameSession.currentQuestionIndex++;
    const currentQuestionSet = getCurrentQuestionSet();

    if (!currentQuestionSet || gameSession.currentQuestionIndex >= currentQuestionSet.questions.length) {
        endGame();
        return;
    }

    const nextQuestion = currentQuestionSet.questions[gameSession.currentQuestionIndex];
    gameSession.currentQuestion = nextQuestion;
    gameSession.players.forEach(p => p.answers = {});

    gameSession.status = 'showing_question';
    io.emit('showing-question', {
        id: nextQuestion.id,
        questionText: nextQuestion.questionText,
        timeLimit: nextQuestion.defaultTimeLimit
    });
    console.log(`Admin: Hiển thị câu hỏi ${nextQuestion.questionText} (5s)`);

    gameSession.questionDisplayTimer = setTimeout(() => {
        gameSession.status = 'countdown_to_options';
        let countdown = 3;
        io.emit('countdown', countdown);
        gameSession.countdownTimer = setInterval(() => {
            countdown--;
            if (countdown > 0) {
                io.emit('countdown', countdown);
            } else {
                clearInterval(gameSession.countdownTimer);
                gameSession.countdownTimer = null;
                gameSession.status = 'playing';
                gameSession.questionStartTime = Date.now();
                gameSession.questionEndTime = gameSession.questionStartTime + (nextQuestion.defaultTimeLimit * 1000);

                io.emit('new-question', {
                    id: nextQuestion.id,
                    questionText: nextQuestion.questionText,
                    options: nextQuestion.options,
                    timeLimit: nextQuestion.defaultTimeLimit
                });
                console.log(`Admin: Bắt đầu câu hỏi ${nextQuestion.questionText} (${nextQuestion.defaultTimeLimit}s)`);

                gameSession.timer = setTimeout(() => {
                    handleQuestionEnd();
                }, nextQuestion.defaultTimeLimit * 1000);
            }
        }, 1000);
    }, 5000);
}

function handleQuestionEnd() {
    clearGameTimers();
    gameSession.status = 'showing_results';

    const currentLeaderboard = calculateCurrentLeaderboard();
    io.emit('question-ended', {
        questionId: gameSession.currentQuestion.id,
        correctAnswerId: gameSession.currentQuestion.correctAnswerId,
        leaderboard: currentLeaderboard
    });

    io.emit('player-list-update', gameSession.players.map(p => ({ id: p.id, nickname: p.nickname, avatarId: p.avatarId, score: p.score, connected: p.connected })));
    io.emit('admin-leaderboard-update', gameSession.adminLeaderboard.map(p => ({ nickname: p.nickname, score: p.score, avatarId: p.avatarId, connected: p.connected })));

    console.log(`Hết giờ cho câu hỏi ${gameSession.currentQuestion.id}. Hiển thị kết quả.`);

    gameSession.timer = setTimeout(() => {
        const currentQuestionSet = getCurrentQuestionSet();
        if (currentQuestionSet && gameSession.currentQuestionIndex + 1 < currentQuestionSet.questions.length) {
            io.emit('next-question-ready');
            moveToNextQuestion();
        } else {
            endGame();
        }
    }, 5000);
}

function endGame() {
    clearGameTimers();
    gameSession.status = 'ended';
    gameSession.currentQuestion = null;

    gameSession.players.forEach(p => {
        const existingAdminLbIndex = gameSession.adminLeaderboard.findIndex(ap => ap.nickname === p.nickname);
        const playerInfo = { ...p, connected: p.connected };
        if (existingAdminLbIndex !== -1) {
            gameSession.adminLeaderboard[existingAdminLbIndex] = playerInfo;
        } else {
            gameSession.adminLeaderboard.push(playerInfo);
        }
    });

    gameSession.adminLeaderboard.sort((a, b) => b.score - a.score);

    io.emit('game-ended', {
        leaderboard: calculateCurrentLeaderboard(),
        adminLeaderboard: gameSession.adminLeaderboard.map(p => ({ nickname: p.nickname, score: p.score, avatarId: p.avatarId, connected: p.connected }))
    });
    console.log("Trò chơi đã kết thúc. Hiển thị tổng kết.");
}

server.listen(PORT, () => {
    console.log(`Server đang chạy trên cổng ${PORT}`);
    console.log(`Admin Panel (Front-end): https://kahoot-cli.netlify.app/ (Chọn 'Tôi là Admin')`);
});
