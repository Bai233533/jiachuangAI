// ==================== 嘉创AI Cloudflare Worker 版本 ====================
// 等效于 server.js，使用 Cloudflare Workers + D1 数据库

const CHAT_MODEL = 'doubao-seed-2-1-pro-260628';
const ARK_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses';
const IMAGE_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations';
const IMAGE_MODEL = 'doubao-seedream-5-0-pro-260628';
const DEFAULT_CHAT_PROMPT = '你是嘉创AI助手，一个智能且专业的AI助手。请用中文回答用户的问题。';

/* ==================== CORS 工具 ==================== */
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

/* ==================== 密码哈希（Web Crypto API） ==================== */
async function hashPassword(password, salt) {
    const data = new TextEncoder().encode(salt + password);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateSalt() {
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, storedHash) {
    // storedHash 格式: salt:hash
    const [salt, hash] = storedHash.split(':');
    if (!salt || !hash) return false;
    const newHash = await hashPassword(password, salt);
    return newHash === hash;
}

function makeSaltedHash(password, salt) {
    return hashPassword(password, salt);
}

/* ==================== URL 解析工具 ==================== */
function parseUrl(url) {
    const u = new URL(url);
    const path = u.pathname;
    const params = {};
    u.searchParams.forEach((v, k) => { params[k] = v; });
    return { path, params };
}

/* ==================== 主路由处理器 ==================== */
async function handleRequest(request, env, ctx) {
    const { path, params } = parseUrl(request.url);
    const method = request.method;

    // ---------- CORS 预检 ----------
    if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ---------- 健康检查 ----------
    if (method === 'GET' && path === '/api/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // ---------- AI 对话（流式代理） ----------
    if (method === 'POST' && path === '/api/chat') {
        return handleChat(request, env);
    }

    // ---------- 图像生成 ----------
    if (method === 'POST' && path === '/api/generate-image') {
        return handleGenerateImage(request, env);
    }

    // ---------- 用户注册 ----------
    if (method === 'POST' && path === '/api/auth/register') {
        return handleRegister(request, env);
    }

    // ---------- 用户登录 ----------
    if (method === 'POST' && path === '/api/auth/login') {
        return handleLogin(request, env);
    }

    // ---------- 卡密激活 ----------
    if (method === 'POST' && path === '/api/auth/activate') {
        return handleActivate(request, env);
    }

    // ---------- 管理员生成卡密 ----------
    if (method === 'POST' && path === '/api/auth/generate-card') {
        return handleGenerateCard(request, env);
    }

    // ---------- VIP 状态 ----------
    if (method === 'GET' && path === '/api/auth/vip-status') {
        return handleVipStatus(request, env);
    }

    // ---------- 搜索对话（必须在 :id 路由之前） ----------
    if (method === 'GET' && path === '/api/conversations/search') {
        return handleSearchConversations(request, env);
    }

    // ---------- 获取所有对话 ----------
    if (method === 'GET' && path === '/api/conversations') {
        return handleGetConversations(request, env);
    }

    // ---------- 获取单个对话 ----------
    const convMatch = path.match(/^\/api\/conversations\/(\d+)$/);
    if (method === 'GET' && convMatch) {
        return handleGetConversation(request, env, convMatch[1]);
    }

    // ---------- 创建对话 ----------
    if (method === 'POST' && path === '/api/conversations') {
        return handleCreateConversation(request, env);
    }

    // ---------- 更新对话 ----------
    if (method === 'PUT' && convMatch) {
        return handleUpdateConversation(request, env, convMatch[1]);
    }

    // ---------- 删除对话 ----------
    if (method === 'DELETE' && convMatch) {
        return handleDeleteConversation(request, env, convMatch[1]);
    }

    // ---------- 获取所有模板 ----------
    if (method === 'GET' && path === '/api/templates') {
        return handleGetTemplates(env);
    }

    // ---------- 获取单个模板 ----------
    const tplMatch = path.match(/^\/api\/templates\/(\d+)$/);
    if (method === 'GET' && tplMatch) {
        return handleGetTemplate(env, tplMatch[1]);
    }

    // ---------- 创建模板 ----------
    if (method === 'POST' && path === '/api/templates') {
        return handleCreateTemplate(request, env);
    }

    // ---------- 更新模板 ----------
    if (method === 'PUT' && tplMatch) {
        return handleUpdateTemplate(request, env, tplMatch[1]);
    }

    // ---------- 删除模板 ----------
    if (method === 'DELETE' && tplMatch) {
        return handleDeleteTemplate(env, tplMatch[1]);
    }

    // ---------- 兜底 ----------
    return jsonResponse({ error: '接口不存在' }, 404);
}

/* ==================== POST /api/chat ==================== */
async function handleChat(request, env) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

    const { messages, stream } = body;

    if (!messages || !Array.isArray(messages)) {
        return jsonResponse({ error: '消息格式错误' }, 400);
    }

    const apiKey = env.ARK_API_KEY;
    if (!apiKey) {
        return jsonResponse({ error: '服务端未配置 ARK_API_KEY' }, 500);
    }

    try {
        const systemPrompt = env.CHAT_SYSTEM_PROMPT || DEFAULT_CHAT_PROMPT;

        // 构建 input：将 system prompt 作为 system 消息注入
        const input = [
            { role: 'system', content: systemPrompt },
            ...messages
        ];

        const requestBody = {
            model: CHAT_MODEL,
            input,
        };

        if (stream !== false) {
            requestBody.stream = true;
        }

        const response = await fetch(ARK_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('豆包 API 错误:', response.status, errText);
            return jsonResponse({ error: '豆包 API 请求失败: ' + errText }, response.status);
        }

        // 流式响应
        if (stream !== false && response.body) {
            const headers = new Headers({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
                ...CORS_HEADERS,
            });

            // 使用 TransformStream 透传 SSE 流
            const reader = response.body.getReader();
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();

            const stream2 = new ReadableStream({
                async start(ctrl) {
                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) {
                                ctrl.enqueue(encoder.encode('data: [DONE]\n\n'));
                                ctrl.close();
                                break;
                            }
                            ctrl.enqueue(value);
                        }
                    } catch (err) {
                        console.error('流读取错误:', err);
                        ctrl.close();
                    }
                }
            });

            return new Response(stream2, { status: 200, headers });
        } else {
            const result = await response.json();
            return jsonResponse(result);
        }
    } catch (error) {
        console.error('服务器错误:', error);
        return jsonResponse({ error: '服务器内部错误: ' + error.message }, 500);
    }
}

/* ==================== POST /api/generate-image ==================== */
async function handleGenerateImage(request, env) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

    const { prompt, image } = body;

    if (!prompt) {
        return jsonResponse({ error: '请输入图像描述' }, 400);
    }

    const apiKey = env.ARK_API_KEY;
    if (!apiKey) {
        return jsonResponse({ error: '服务端未配置 ARK_API_KEY' }, 500);
    }

    try {
        const requestBody = {
            model: IMAGE_MODEL,
            prompt: prompt,
            response_format: 'url',
            size: '2K',
            stream: false,
            watermark: true,
        };

        if (image) {
            requestBody.image = image;
        }

        const response = await fetch(IMAGE_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
            },
            body: JSON.stringify(requestBody),
        });

        const result = await response.json();

        if (!response.ok) {
            console.error('图像生成 API 错误:', response.status, result);
            return jsonResponse({ error: result.error?.message || '图像生成失败' }, response.status);
        }

        const images = [];
        if (result.data && Array.isArray(result.data)) {
            for (const item of result.data) {
                if (item.url) images.push(item.url);
            }
        }

        return jsonResponse({ images, raw: result });
    } catch (error) {
        console.error('图像生成服务器错误:', error);
        return jsonResponse({ error: '服务器内部错误: ' + error.message }, 500);
    }
}

/* ==================== POST /api/auth/register ==================== */
async function handleRegister(request, env) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

    const { username, password, nickname } = body;

    if (!username || !password) {
        return jsonResponse({ error: '账号和密码不能为空' }, 400);
    }
    if (username.length < 3 || username.length > 20) {
        return jsonResponse({ error: '账号长度需要 3-20 个字符' }, 400);
    }
    if (password.length < 6) {
        return jsonResponse({ error: '密码长度至少 6 个字符' }, 400);
    }

    const db = env.DB;

    // 检查账号是否已存在
    const exists = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (exists) {
        return jsonResponse({ error: '该账号已被注册' }, 400);
    }

    // 密码哈希存储（salt + SHA-256）
    const salt = generateSalt();
    const hash = await hashPassword(password, salt);
    const hashedPassword = salt + ':' + hash;

    const result = await db.prepare(
        'INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)'
    ).bind(username, hashedPassword, nickname || username).run();

    const userId = result.meta.last_row_rowid;

    return jsonResponse({
        success: true,
        message: '注册成功',
        user: { id: userId, username, nickname: username },
    });
}

/* ==================== POST /api/auth/login ==================== */
async function handleLogin(request, env) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

    const { username, password } = body;

    if (!username || !password) {
        return jsonResponse({ error: '账号和密码不能为空' }, 400);
    }

    const db = env.DB;

    const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    if (!user) {
        return jsonResponse({ error: '账号不存在' }, 400);
    }
    if (user.status === 0) {
        return jsonResponse({ error: '该账号已被封禁' }, 400);
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
        return jsonResponse({ error: '密码错误' }, 400);
    }

    // 更新最后登录时间
    await db.prepare('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run();

    // 查询用户的卡密信息
    const cardKey = await db.prepare(
        "SELECT * FROM card_keys WHERE user_id = ? AND status = 'used' ORDER BY used_at DESC LIMIT 1"
    ).bind(user.id).first();

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
                expire_at: expireAt.toISOString(),
            };
        } else {
            // VIP 已过期，更新卡密状态
            await db.prepare("UPDATE card_keys SET status = 'expired' WHERE id = ?").bind(cardKey.id).run();
        }
    }

    return jsonResponse({
        success: true,
        message: '登录成功',
        user: {
            id: user.id,
            username: user.username,
            nickname: user.nickname,
            status: user.status,
        },
        vip: vipInfo,
    });
}

/* ==================== POST /api/auth/activate ==================== */
async function handleActivate(request, env) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

    const { cardKey, userId } = body;

    if (!cardKey) {
        return jsonResponse({ error: '请输入卡密' }, 400);
    }

    const db = env.DB;

    const card = await db.prepare("SELECT * FROM card_keys WHERE card_key = ? AND status = 'unused'").bind(cardKey).first();
    if (!card) {
        return jsonResponse({ error: '卡密无效或已使用' }, 400);
    }

    // 查询用户当前VIP到期时间（取最近一次使用的卡密）
    const lastCard = await db.prepare(
        "SELECT used_at, duration_days FROM card_keys WHERE user_id = ? AND status = 'used' ORDER BY used_at DESC LIMIT 1"
    ).bind(userId).first();

    let baseTime;
    if (lastCard) {
        const lastExpire = new Date(lastCard.used_at + 'Z').getTime() + lastCard.duration_days * 24 * 60 * 60 * 1000;
        baseTime = lastExpire > Date.now() ? lastExpire : Date.now();
    } else {
        baseTime = Date.now();
    }

    const expireAt = new Date(baseTime + card.duration_days * 24 * 60 * 60 * 1000);

    // 激活卡密
    await db.prepare(
        "UPDATE card_keys SET status = 'used', user_id = ?, used_at = datetime(?, 'unixepoch') WHERE id = ?"
    ).bind(userId, Math.floor(baseTime / 1000), card.id).run();

    return jsonResponse({
        success: true,
        message: '激活成功',
        vip: {
            type: card.type,
            duration_days: card.duration_days,
            expire_at: expireAt.toISOString(),
        },
    });
}

/* ==================== POST /api/auth/generate-card ==================== */
async function handleGenerateCard(request, env) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

    const { adminSecret, type, durationDays, count } = body;

    // 简单的管理员密钥验证
    if (adminSecret !== 'jiachuang-admin-2024') {
        return jsonResponse({ error: '管理员密钥错误' }, 403);
    }

    const db = env.DB;

    const num = Math.min(count || 1, 100);
    const cards = [];
    const segment = () => Math.random().toString(36).substring(2, 6).toUpperCase();

    for (let i = 0; i < num; i++) {
        const key = `JC-${segment()}-${segment()}-${segment()}`;
        await db.prepare(
            'INSERT INTO card_keys (card_key, type, duration_days) VALUES (?, ?, ?)'
        ).bind(key, type || 'vip', durationDays || 30).run();
        cards.push(key);
    }

    return jsonResponse({ success: true, message: `成功生成 ${num} 张卡密`, cards });
}

/* ==================== GET /api/auth/vip-status ==================== */
async function handleVipStatus(request, env) {
    const { params } = parseUrl(request.url);
    const userId = params.userId;

    if (!userId) {
        return jsonResponse({ error: '缺少用户ID' }, 400);
    }

    const db = env.DB;

    const card = await db.prepare(
        "SELECT used_at, duration_days FROM card_keys WHERE user_id = ? AND status = 'used' ORDER BY used_at DESC LIMIT 1"
    ).bind(userId).first();

    if (!card) {
        return jsonResponse({ isVip: false, expireAt: null });
    }

    const usedAt = new Date(card.used_at + 'Z');
    const expireAt = new Date(usedAt.getTime() + card.duration_days * 24 * 60 * 60 * 1000);
    const isVip = expireAt > new Date();

    return jsonResponse({ isVip, expireAt: expireAt.toISOString() });
}

/* ==================== GET /api/conversations ==================== */
async function handleGetConversations(request, env) {
    const { params } = parseUrl(request.url);
    const userId = params.userId;

    if (!userId) {
        return jsonResponse({ error: '缺少用户ID' }, 400);
    }

    const db = env.DB;

    const { results: convs } = await db.prepare(
        'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
    ).bind(userId).all();

    return jsonResponse({ conversations: convs });
}

/* ==================== GET /api/conversations/search ==================== */
async function handleSearchConversations(request, env) {
    const { params } = parseUrl(request.url);
    const { userId, keyword } = params;

    if (!userId || !keyword) {
        return jsonResponse({ byTitle: [], byContent: [] });
    }

    const db = env.DB;

    const { results: allConvs } = await db.prepare(
        'SELECT id, title, messages, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC'
    ).bind(userId).all();

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
        } catch (e) {
            // ignore parse errors
        }
    }

    return jsonResponse({ byTitle, byContent });
}

/* ==================== GET /api/conversations/:id ==================== */
async function handleGetConversation(request, env, id) {
    const { params } = parseUrl(request.url);
    const userId = params.userId;

    if (!userId) {
        return jsonResponse({ error: '缺少用户ID' }, 400);
    }

    const db = env.DB;

    const conv = await db.prepare(
        'SELECT * FROM conversations WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first();

    if (!conv) {
        return jsonResponse({ error: '对话不存在' }, 404);
    }

    conv.messages = JSON.parse(conv.messages || '[]');
    return jsonResponse(conv);
}

/* ==================== POST /api/conversations ==================== */
async function handleCreateConversation(request, env) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

    const { userId, title } = body;

    if (!userId) {
        return jsonResponse({ error: '缺少用户ID' }, 400);
    }

    const db = env.DB;

    const result = await db.prepare(
        'INSERT INTO conversations (user_id, title) VALUES (?, ?)'
    ).bind(userId, title || '新对话').run();

    return jsonResponse({ id: result.meta.last_row_rowid, title: title || '新对话' });
}

/* ==================== PUT /api/conversations/:id ==================== */
async function handleUpdateConversation(request, env, id) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }

    const userId = body.userId;
    if (!userId) {
        return jsonResponse({ error: '缺少用户ID' }, 400);
    }

    const db = env.DB;

    const conv = await db.prepare(
        'SELECT id FROM conversations WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first();

    if (!conv) {
        return jsonResponse({ error: '对话不存在' }, 404);
    }

    const updates = [];
    const bindValues = [];

    if (body.title !== undefined) {
        updates.push('title = ?');
        bindValues.push(body.title);
    }
    if (body.messages !== undefined) {
        updates.push('messages = ?');
        bindValues.push(JSON.stringify(body.messages));
    }
    updates.push('updated_at = CURRENT_TIMESTAMP');

    if (updates.length > 1) {
        bindValues.push(id, userId);
        await db.prepare(
            `UPDATE conversations SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
        ).bind(...bindValues).run();
    }

    return jsonResponse({ success: true });
}

/* ==================== DELETE /api/conversations/:id ==================== */
async function handleDeleteConversation(request, env, id) {
    // DELETE 请求的 body 可能为空，尝试从 URL params 或 body 获取 userId
    let userId = null;

    const { params } = parseUrl(request.url);
    userId = params.userId;

    if (!userId) {
        try {
            const body = await request.json();
            userId = body.userId;
        } catch {
            // no body
        }
    }

    if (!userId) {
        return jsonResponse({ error: '缺少用户ID' }, 400);
    }

    const db = env.DB;

    await db.prepare(
        'DELETE FROM conversations WHERE id = ? AND user_id = ?'
    ).bind(id, userId).run();

    return jsonResponse({ success: true });
}

/* ==================== 模板 CRUD ==================== */
async function handleGetTemplates(env) {
    const db = env.DB;
    const { results } = await db.prepare('SELECT * FROM templates ORDER BY sort_order ASC, id ASC').all();
    return jsonResponse(results);
}

async function handleGetTemplate(env, id) {
    const db = env.DB;
    const row = await db.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    if (!row) return jsonResponse({ error: '模板不存在' }, 404);
    return jsonResponse(row);
}

async function handleCreateTemplate(request, env) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }
    const { name, prompt, effect_url, ref_url } = body;
    if (!name || !prompt) return jsonResponse({ error: '名称和提示词必填' }, 400);
    const db = env.DB;
    const info = await db.prepare(
        'INSERT INTO templates (name, prompt, effect_url, ref_url) VALUES (?, ?, ?, ?)'
    ).bind(name, prompt, effect_url || '', ref_url || '').run();
    return jsonResponse({ id: info.meta.last_row_id });
}

async function handleUpdateTemplate(request, env, id) {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: '请求格式错误' }, 400); }
    const db = env.DB;
    const existing = await db.prepare('SELECT * FROM templates WHERE id = ?').bind(id).first();
    if (!existing) return jsonResponse({ error: '模板不存在' }, 404);
    await db.prepare(
        'UPDATE templates SET name=?, prompt=?, effect_url=?, ref_url=?, sort_order=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).bind(
        body.name ?? existing.name,
        body.prompt ?? existing.prompt,
        body.effect_url ?? existing.effect_url,
        body.ref_url ?? existing.ref_url,
        body.sort_order ?? existing.sort_order,
        id
    ).run();
    return jsonResponse({ success: true });
}

async function handleDeleteTemplate(env, id) {
    const db = env.DB;
    await db.prepare('DELETE FROM templates WHERE id = ?').bind(id).run();
    return jsonResponse({ success: true });
}

/* ==================== D1 初始化（可选：建表） ==================== */
async function initDB(env) {
    const db = env.DB;
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password TEXT NOT NULL,
            nickname TEXT DEFAULT '',
            status INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_login_at DATETIME
        );

        CREATE TABLE IF NOT EXISTS card_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            card_key TEXT NOT NULL UNIQUE,
            type TEXT DEFAULT 'vip',
            duration_days INTEGER DEFAULT 30,
            status TEXT DEFAULT 'unused',
            user_id INTEGER,
            used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            title TEXT DEFAULT '新对话',
            messages TEXT DEFAULT '[]',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
        CREATE INDEX IF NOT EXISTS idx_card_keys_key ON card_keys(card_key);
        CREATE INDEX IF NOT EXISTS idx_card_keys_user ON card_keys(user_id);
        CREATE INDEX IF NOT EXISTS idx_card_keys_status ON card_keys(status);
        CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);

        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            prompt TEXT NOT NULL DEFAULT '',
            effect_url TEXT DEFAULT '',
            ref_url TEXT DEFAULT '',
            author TEXT DEFAULT '嘉创',
            sort_order INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_tpl_sort ON templates(sort_order);
    `);
}

/* ==================== Worker 入口 ==================== */
export default {
    async fetch(request, env, ctx) {
        // 首次请求时初始化数据库表（D1 自动跳过已存在的表）
        ctx.waitUntil(initDB(env));
        return handleRequest(request, env, ctx);
    },
};
