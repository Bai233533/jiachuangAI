const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = 3000;

/* ==================== 数据库初始化 ==================== */
const db = new Database(path.join(__dirname, 'jiachuang.db'));
db.pragma('journal_mode = WAL');

// 执行建表 SQL
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
db.exec(schema);

// 检查并添加images字段（兼容旧数据库）
try {
    db.prepare("SELECT images FROM conversations LIMIT 1").get();
} catch (e) {
    db.exec("ALTER TABLE conversations ADD COLUMN images TEXT DEFAULT '[]'");
    console.log('✅ 已添加images字段到conversations表');
}

// 检查并添加videos字段（兼容旧数据库）
try {
    db.prepare("SELECT videos FROM conversations LIMIT 1").get();
} catch (e) {
    db.exec("ALTER TABLE conversations ADD COLUMN videos TEXT DEFAULT '[]'");
    console.log('✅ 已添加videos字段到conversations表');
}
console.log('✅ 数据库已初始化');

/* ==================== 豆包 API 配置 ==================== */
const ARK_API_KEY = process.env.ARK_API_KEY;
const ARK_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const CHAT_MODEL = 'doubao-seed-2-1-pro-260628';

/* ==================== 中间件 ==================== */
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

/* ==================== 对话 API（流式代理） ==================== */
app.post('/api/chat', async (req, res) => {
    const { messages, stream } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: '消息格式错误' });
    }

    try {
        const requestBody = {
            model: CHAT_MODEL,
            input: messages
        };

        // 如果前端请求流式
        if (stream !== false) {
            requestBody.stream = true;
        }

        const response = await fetch(ARK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + ARK_API_KEY
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('豆包 API 错误:', response.status, errText);
            return res.status(response.status).json({ error: '豆包 API 请求失败: ' + errText });
        }

        // 流式响应：将 SSE 转发给前端
        if (stream !== false && response.body) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            const pump = async () => {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        res.write('data: [DONE]\n\n');
                        res.end();
                        break;
                    }
                    const chunk = decoder.decode(value, { stream: true });
                    res.write(chunk);
                }
            };

            pump().catch(err => {
                console.error('流读取错误:', err);
                res.end();
            });
        } else {
            // 非流式响应
            const result = await response.json();
            res.json(result);
        }
    } catch (error) {
        console.error('服务器错误:', error);
        res.status(500).json({ error: '服务器内部错误: ' + error.message });
    }
});

/* ==================== 用户注册 ==================== */
app.post('/api/auth/register', (req, res) => {
    const { username, password, nickname } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '账号和密码不能为空' });
    }
    if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: '账号长度需要 3-20 个字符' });
    }
    if (password.length < 6) {
        return res.status(400).json({ error: '密码长度至少 6 个字符' });
    }

    // 检查账号是否已存在
    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) {
        return res.status(400).json({ error: '该账号已被注册' });
    }

    // 密码哈希存储
    const hashedPassword = bcrypt.hashSync(password, 10);

    const insertUser = db.prepare('INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)');
    const result = insertUser.run(username, hashedPassword, username);

    const userId = result.lastInsertRowid;

    res.json({
        success: true,
        message: '注册成功',
        user: { id: userId, username, nickname: username }
    });
});

/* ==================== 用户登录 ==================== */
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: '账号和密码不能为空' });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        return res.status(400).json({ error: '账号不存在' });
    }
    if (user.status === 0) {
        return res.status(400).json({ error: '该账号已被封禁' });
    }

    const valid = bcrypt.compareSync(password, user.password);
    if (!valid) {
        return res.status(400).json({ error: '密码错误' });
    }

    // 更新最后登录时间
    db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

    // 查询用户的卡密信息
    const cardKey = db.prepare(
        "SELECT * FROM card_keys WHERE user_id = ? AND status = 'used' ORDER BY used_at DESC LIMIT 1"
    ).get(user.id);

    // 检查 VIP 是否过期
    let vipInfo = null;
    if (cardKey) {
        const usedAt = new Date(cardKey.used_at);
        const expireAt = new Date(usedAt.getTime() + cardKey.duration_days * 24 * 60 * 60 * 1000);
        const now = new Date();
        if (expireAt > now) {
            vipInfo = {
                type: cardKey.type,
                duration_days: cardKey.duration_days,
                used_at: cardKey.used_at,
                expire_at: expireAt.toISOString()
            };
        } else {
            // VIP 已过期，更新卡密状态
            db.prepare("UPDATE card_keys SET status = 'expired' WHERE id = ?").run(cardKey.id);
        }
    }

    res.json({
        success: true,
        message: '登录成功',
        user: {
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            status: user.status
        },
        vip: vipInfo
    });
});

/* ==================== 卡密验证 ==================== */
app.post('/api/auth/activate', (req, res) => {
    const { cardKey, userId } = req.body;

    if (!cardKey) {
        return res.status(400).json({ error: '请输入卡密' });
    }

    const card = db.prepare("SELECT * FROM card_keys WHERE card_key = ? AND status = 'unused'").get(cardKey);
    if (!card) {
        return res.status(400).json({ error: '卡密无效或已使用' });
    }

    // 查询用户当前VIP到期时间（取最近一次使用的卡密）
    const lastCard = db.prepare(
        "SELECT used_at, duration_days FROM card_keys WHERE user_id = ? AND status = 'used' ORDER BY used_at DESC LIMIT 1"
    ).get(userId);

    let baseTime;
    if (lastCard) {
        const lastExpire = new Date(lastCard.used_at + 'Z').getTime() + lastCard.duration_days * 24 * 60 * 60 * 1000;
        // 如果当前还没过期，从到期时间开始加；如果已过期，从当前时间开始加
        baseTime = lastExpire > Date.now() ? lastExpire : Date.now();
    } else {
        baseTime = Date.now();
    }

    const expireAt = new Date(baseTime + card.duration_days * 24 * 60 * 60 * 1000);

    // 激活卡密
    db.prepare(
        "UPDATE card_keys SET status = 'used', user_id = ?, used_at = datetime(?, 'unixepoch') WHERE id = ?"
    ).run(userId, Math.floor(baseTime / 1000), card.id);

    res.json({
        success: true,
        message: '激活成功',
        vip: {
            type: card.type,
            duration_days: card.duration_days,
            expire_at: expireAt.toISOString()
        }
    });
});

/* ==================== 管理员：生成卡密 ==================== */
app.post('/api/auth/generate-card', (req, res) => {
    const { adminSecret, type, durationDays, count } = req.body;

    // 简单的管理员密钥验证
    if (adminSecret !== '233') {
        return res.status(403).json({ error: '管理员密钥错误' });
    }

    const num = Math.min(count || 1, 100); // 最多一次生成100张
    const cards = [];
    const stmt = db.prepare('INSERT INTO card_keys (card_key, type, duration_days) VALUES (?, ?, ?)');

    for (let i = 0; i < num; i++) {
        // 生成随机卡密：JC-XXXX-XXXX-XXXX
        const segment = () => Math.random().toString(36).substring(2, 6).toUpperCase();
        const key = `JC-${segment()}-${segment()}-${segment()}`;
        stmt.run(key, type || 'vip', durationDays || 30);
        cards.push(key);
    }

    res.json({ success: true, message: `成功生成 ${num} 张卡密`, cards });
});

/* ==================== 对话管理 API ==================== */

// 获取用户的所有对话
app.get('/api/conversations', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });

    const convs = db.prepare(
        'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
    ).all(userId);

    res.json({ conversations: convs });
});

/* ==================== 搜索对话（必须在 :id 路由之前） ==================== */
app.get('/api/conversations/search', (req, res) => {
    const { userId, keyword } = req.query;
    if (!userId || !keyword) return res.json({ byTitle: [], byContent: [] });

    const allConvs = db.prepare(
        'SELECT id, title, messages, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
    ).all(userId);

    const kw = keyword.toLowerCase();
    const byTitle = [];
    const byContent = [];

    for (const conv of allConvs) {
        if (conv.title && conv.title.toLowerCase().includes(kw)) {
            byTitle.push({ id: conv.id, title: conv.title, updated_at: conv.updated_at });
            continue;
        }
        try {
            const messages = JSON.parse(conv.messages || '[]');
            for (const msg of messages) {
                let text = '';
                if (typeof msg.content === 'string') {
                    text = msg.content;
                } else if (Array.isArray(msg.content)) {
                    text = msg.content.map(c => c.text || '').join(' ');
                }
                if (text.toLowerCase().includes(kw)) {
                    const lowerText = text.toLowerCase();
                    const idx = lowerText.indexOf(kw);
                    const start = Math.max(0, idx - 30);
                    const end = Math.min(text.length, idx + kw.length + 30);
                    const snippet = (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : '');
                    byContent.push({ id: conv.id, title: conv.title, snippet, role: msg.role, updated_at: conv.updated_at });
                    break;
                }
            }
        } catch (e) {}
    }

    res.json({ byTitle, byContent });
});

// 获取单个对话详情（含消息）
app.get('/api/conversations/:id', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });

    const conv = db.prepare(
        'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
    ).get(req.params.id, userId);

    if (!conv) return res.status(404).json({ error: '对话不存在' });

    conv.messages = JSON.parse(conv.messages || '[]');
    conv.images = JSON.parse(conv.images || '[]');
    conv.videos = JSON.parse(conv.videos || '[]');
    res.json(conv);
});

// 创建新对话
app.post('/api/conversations', (req, res) => {
    const { userId, title } = req.body;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });

    const result = db.prepare(
        'INSERT INTO conversations (user_id, title) VALUES (?, ?)'
    ).run(userId, title || '新对话');

    res.json({ id: result.lastInsertRowid, title: title || '新对话' });
});

// 更新对话（标题/消息）
app.put('/api/conversations/:id', (req, res) => {
    const userId = req.body.userId || req.query.userId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });

    const conv = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?')
        .get(req.params.id, userId);
    if (!conv) return res.status(404).json({ error: '对话不存在' });

    const updates = [];
    const params = [];

    if (req.body.title !== undefined) {
        updates.push('title = ?');
        params.push(req.body.title);
    }
    if (req.body.messages !== undefined) {
        updates.push('messages = ?');
        params.push(JSON.stringify(req.body.messages));
    }
    if (req.body.images !== undefined) {
        updates.push('images = ?');
        params.push(JSON.stringify(req.body.images));
    }
    if (req.body.videos !== undefined) {
        updates.push('videos = ?');
        params.push(JSON.stringify(req.body.videos));
    }
    updates.push('updated_at = CURRENT_TIMESTAMP');

    if (updates.length > 1) {
        params.push(req.params.id, userId);
        db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`)
            .run(...params);
    }

    res.json({ success: true });
});

// 删除对话
app.delete('/api/conversations/:id', (req, res) => {
    const userId = req.query.userId || req.body.userId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });

    db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?')
        .run(req.params.id, userId);

    res.json({ success: true });
});

/* ==================== 用户 VIP 状态 ==================== */
app.get('/api/auth/vip-status', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: '缺少用户ID' });

    // 查询最近一次使用的卡密（含赠送的体验卡）
    const card = db.prepare(
        "SELECT used_at, duration_days FROM card_keys WHERE user_id = ? AND status = 'used' ORDER BY used_at DESC LIMIT 1"
    ).get(userId);

    if (!card) {
        return res.json({ isVip: false, expireAt: null });
    }

    // 计算到期时间 = 使用时间 + 有效天数
    const usedAt = new Date(card.used_at + 'Z');
    const expireAt = new Date(usedAt.getTime() + card.duration_days * 24 * 60 * 60 * 1000);
    const isVip = expireAt > new Date();

    res.json({ isVip, expireAt: expireAt.toISOString() });
});

/* ==================== 健康检查 ==================== */
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/* ==================== Agnes 视频生成 API 配置 ==================== */
const AGNES_API_KEY = process.env.AGNES_API_KEY || 'cpk-b8NrIukJ8Vwk9kArOPsZClc3DAIB9gFQbP6683iWCya7TpIE';
const AGNES_VIDEO_URL = 'https://apihub.agnes-ai.com/v1/videos';
const AGNES_VIDEO_RESULT_URL = 'https://apihub.agnes-ai.com/agnesapi';

/* ==================== 图像生成 API ==================== */
const IMAGE_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const IMAGE_MODEL = 'doubao-seedream-5-0-pro-260628';

app.post('/api/generate-image', async (req, res) => {
    const { prompt, image } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: '请输入图像描述' });
    }

    try {
        const requestBody = {
            model: IMAGE_MODEL,
            prompt: prompt,
            response_format: 'url',
            size: '2K',
            stream: false,
            watermark: true
        };

        // 如果有参考图（单张或数组）
        if (image) {
            requestBody.image = image;
        }

        console.log('图像生成请求:', JSON.stringify({ prompt: prompt.slice(0, 50), hasImage: !!image }));

        const response = await fetch(IMAGE_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + ARK_API_KEY
            },
            body: JSON.stringify(requestBody)
        });

        const result = await response.json();

        if (!response.ok) {
            console.error('图像生成 API 错误:', response.status, result);
            return res.status(response.status).json({ error: result.error?.message || '图像生成失败' });
        }

        // 提取图片 URL
        const images = [];
        if (result.data && Array.isArray(result.data)) {
            for (const item of result.data) {
                if (item.url) images.push(item.url);
            }
        }

        res.json({ images, raw: result });
    } catch (error) {
        console.error('图像生成服务器错误:', error);
        res.status(500).json({ error: '服务器内部错误: ' + error.message });
    }
});

/* ==================== 视频生成 API ==================== */

// 创建视频生成任务
app.post('/api/video/generate', async (req, res) => {
    const { prompt, mode, orientation, duration, userId, conversationId } = req.body;

    if (!prompt) {
        return res.status(400).json({ error: '请输入视频描述' });
    }

    // 参数映射
    const modeMap = { fast: 20, quality: 50 };
    const orientationMap = {
        landscape: { width: 1152, height: 768 },
        portrait: { width: 768, height: 1152 }
    };
    const durationFrames = { 5: 121, 8: 193, 10: 241 };

    const numInferenceSteps = modeMap[mode] || 20;
    const { width, height } = orientationMap[orientation] || { width: 1152, height: 768 };
    const numFrames = durationFrames[duration] || 121;

    try {
        const requestBody = {
            model: 'agnes-video-v2.0',
            prompt: prompt,
            width: width,
            height: height,
            num_frames: numFrames,
            frame_rate: 24,
            num_inference_steps: numInferenceSteps
        };

        console.log('视频生成请求:', JSON.stringify({ prompt: prompt.slice(0, 50), mode, orientation, duration }));
        console.log('使用 API Key:', AGNES_API_KEY.slice(0, 8) + '...' + AGNES_API_KEY.slice(-6));

        const response = await fetch(AGNES_VIDEO_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + AGNES_API_KEY
            },
            body: JSON.stringify(requestBody)
        });

        const result = await response.json();

        // 详细日志：打印完整 API 响应
        console.log('Agnes API 响应状态:', response.status);
        console.log('Agnes API 完整响应:', JSON.stringify(result, null, 2));

        if (!response.ok) {
            console.error('视频生成 API 错误:', response.status, result);
            return res.status(response.status).json({ error: result.error?.message || result.message || '视频任务创建失败' });
        }

        // 保存到数据库
        // API 返回格式：{ video_id, task_id, status, ... } 或 { data: { video_id, ... } }
        const videoData = result.data || result;
        const videoId = videoData.video_id || '';
        const taskId = videoData.task_id || '';

        if (userId && videoId) {
            db.prepare(
                `INSERT INTO generated_videos (user_id, task_id, video_id, prompt, mode, orientation, duration, width, height, num_frames, status, conversation_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                userId,
                taskId,
                videoId,
                prompt,
                mode || 'fast',
                orientation || 'landscape',
                duration || 5,
                width,
                height,
                numFrames,
                videoData.status || 'queued',
                conversationId || null
            );
        }

        console.log('视频任务创建成功:', { videoId, taskId, status: videoData.status });

        res.json({
            videoId: videoId,
            taskId: taskId,
            status: videoData.status || 'queued',
            raw: result
        });
    } catch (error) {
        console.error('视频生成服务器错误:', error);
        res.status(500).json({ error: '服务器内部错误: ' + error.message });
    }
});

// 轮询查询视频生成状态
app.get('/api/video/result', async (req, res) => {
    const { video_id } = req.query;

    if (!video_id) {
        return res.status(400).json({ error: '缺少 video_id' });
    }

    try {
        // 尝试两种查询方式
        let url = `${AGNES_VIDEO_RESULT_URL}?video_id=${video_id}`;
        let response = await fetch(url, {
            headers: { 'Authorization': 'Bearer ' + AGNES_API_KEY }
        });

        let result = await response.json();
        console.log('视频查询结果 (agnesapi):', JSON.stringify(result));

        // 如果第一种方式没有 url，尝试 task_id 方式
        if (!result.metadata?.url) {
            url = `${AGNES_VIDEO_URL}/${video_id}`;
            response = await fetch(url, {
                headers: { 'Authorization': 'Bearer ' + AGNES_API_KEY }
            });
            result = await response.json();
            console.log('视频查询结果 (v1/videos):', JSON.stringify(result));
        }

        if (!response.ok) {
            return res.status(response.status).json({ error: result.error?.message || '查询失败' });
        }

        // API 返回格式：{ status, progress, metadata: { url } } 或 { data: { status, ... } }
        const resultData = result.data || result;
        const status = resultData.status || 'unknown';
        const progress = resultData.progress || 0;
        const videoUrl = resultData.metadata?.url || '';
        const error = resultData.error || '';

        // 更新数据库状态
        const video = db.prepare('SELECT * FROM generated_videos WHERE video_id = ?').get(video_id);
        if (video) {
            db.prepare(
                `UPDATE generated_videos SET status = ?, progress = ?, video_url = ?, error = ?,
                 completed_at = CASE WHEN ? IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE completed_at END
                 WHERE video_id = ?`
            ).run(status, progress, videoUrl, error, status, video_id);
        }

        console.log('视频状态查询:', { video_id, status, progress, hasUrl: !!videoUrl });

        res.json({
            status: status,
            progress: progress,
            videoUrl: videoUrl,
            error: error,
            raw: result
        });
    } catch (error) {
        console.error('视频状态查询错误:', error);
        res.status(500).json({ error: '服务器内部错误: ' + error.message });
    }
});

// 代理下载视频文件（避免前端直接访问 Agnes 临时链接）
app.get('/api/video/download', async (req, res) => {
    const { video_id } = req.query;

    if (!video_id) {
        return res.status(400).json({ error: '缺少 video_id' });
    }

    try {
        // 先查询数据库获取 URL
        const video = db.prepare('SELECT video_url FROM generated_videos WHERE video_id = ?').get(video_id);
        if (!video || !video.video_url) {
            return res.status(404).json({ error: '视频 URL 不存在，请稍后重试' });
        }

        const response = await fetch(video.video_url);
        if (!response.ok) {
            return res.status(response.status).json({ error: '视频下载失败' });
        }

        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `inline; filename="video_${video_id}.mp4"`);

        const reader = response.body.getReader();
        const pump = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); break; }
                res.write(value);
            }
        };
        pump().catch(err => {
            console.error('视频流传输错误:', err);
            res.end();
        });
    } catch (error) {
        console.error('视频下载代理错误:', error);
        res.status(500).json({ error: '服务器内部错误: ' + error.message });
    }
});

/* ==================== 模板 CRUD API ==================== */

// 获取所有模板
app.get('/api/templates', (req, res) => {
    const rows = db.prepare('SELECT * FROM templates ORDER BY sort_order ASC, id ASC').all();
    res.json(rows);
});

// 获取单个模板
app.get('/api/templates/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '模板不存在' });
    res.json(row);
});

// 新增模板
app.post('/api/templates', (req, res) => {
    const { name, prompt, effect_url, ref_url } = req.body;
    if (!name || !prompt) return res.status(400).json({ error: '名称和提示词必填' });
    const info = db.prepare(
        'INSERT INTO templates (name, prompt, effect_url, ref_url) VALUES (?, ?, ?, ?)'
    ).run(name, prompt, effect_url || '', ref_url || '');
    res.json({ id: info.lastInsertRowid });
});

// 更新模板
app.put('/api/templates/:id', (req, res) => {
    const { name, prompt, effect_url, ref_url, sort_order } = req.body;
    const existing = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '模板不存在' });
    db.prepare(
        'UPDATE templates SET name=?, prompt=?, effect_url=?, ref_url=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).run(
        name ?? existing.name,
        prompt ?? existing.prompt,
        effect_url ?? existing.effect_url,
        ref_url ?? existing.ref_url,
        sort_order ?? existing.sort_order,
        req.params.id
    );
    res.json({ success: true });
});

// 删除模板
app.delete('/api/templates/:id', (req, res) => {
    db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

/* ==================== 兜底：返回 index.html ==================== */
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

/* ==================== 启动服务器 ==================== */
app.listen(PORT, () => {
    console.log(`✅ 服务器已启动: http://localhost:${PORT}`);
    console.log(`   豆包对话模型: ${CHAT_MODEL}`);
});
