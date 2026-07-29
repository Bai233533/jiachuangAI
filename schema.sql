-- ==================== 嘉创AI 数据库建表语句 ====================
-- 兼容 Cloudflare D1 (SQLite) + 本地 better-sqlite3

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,           -- 账号（唯一）
    password TEXT NOT NULL,                  -- 密码（bcrypt 哈希存储）
    nickname TEXT DEFAULT '',                -- 昵称
    status INTEGER DEFAULT 1,               -- 状态：1=正常，0=封禁
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 注册时间
    last_login_at DATETIME                   -- 最后登录时间
);

-- 卡密表
CREATE TABLE IF NOT EXISTS card_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_key TEXT NOT NULL UNIQUE,           -- 卡密值（唯一）
    type TEXT DEFAULT 'vip',                 -- 类型：vip=会员
    duration_days INTEGER DEFAULT 30,        -- 有效天数
    status TEXT DEFAULT 'unused',            -- 状态：unused=未使用，used=已使用，expired=已过期
    user_id INTEGER,                         -- 关联用户ID（使用后填写）
    used_at DATETIME,                        -- 使用时间
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 生成时间
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_card_keys_key ON card_keys(card_key);
CREATE INDEX IF NOT EXISTS idx_card_keys_user ON card_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_card_keys_status ON card_keys(status);

-- 对话表
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,                -- 关联用户ID
    title TEXT DEFAULT '新对话',             -- 对话标题
    messages TEXT DEFAULT '[]',              -- 消息列表（JSON字符串）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 对话表索引
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);
