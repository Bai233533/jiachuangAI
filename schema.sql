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
    images TEXT DEFAULT '[]',                -- 图片列表（JSON字符串，存储每个消息对应的图片）
    videos TEXT DEFAULT '[]',                -- 视频列表（JSON字符串，存储每个消息对应的视频）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 对话表索引
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id);

-- 模板表
CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,                       -- 模板名称
    prompt TEXT NOT NULL DEFAULT '',           -- 提示词内容
    effect_url TEXT DEFAULT '',               -- 效果图URL/Base64
    ref_url TEXT DEFAULT '',                  -- 参考图URL/Base64
    author TEXT DEFAULT '嘉创',               -- 作者
    sort_order INTEGER DEFAULT 0,            -- 排序权重
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,  -- 创建日期
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP   -- 编辑日期
);

-- 模板表索引
CREATE INDEX IF NOT EXISTS idx_tpl_sort ON templates(sort_order);

-- 生成视频记录表
CREATE TABLE IF NOT EXISTS generated_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,                -- 关联用户ID
    task_id TEXT NOT NULL,                   -- Agnes 任务ID
    video_id TEXT NOT NULL,                  -- Agnes 视频ID
    prompt TEXT NOT NULL,                    -- 用户输入的提示词
    mode TEXT DEFAULT 'fast',               -- 模式：fast=快速，quality=质量
    orientation TEXT DEFAULT 'landscape',    -- 方向：landscape=横向，portrait=纵向
    duration INTEGER DEFAULT 5,             -- 时长（秒）：5/8/10
    width INTEGER DEFAULT 1152,             -- 视频宽度
    height INTEGER DEFAULT 768,             -- 视频高度
    num_frames INTEGER DEFAULT 121,         -- 帧数
    status TEXT DEFAULT 'queued',           -- 状态：queued/in_progress/completed/failed
    progress INTEGER DEFAULT 0,             -- 进度百分比
    video_url TEXT DEFAULT '',              -- 生成的视频URL
    local_path TEXT DEFAULT '',             -- 本地缓存路径（如已下载）
    error TEXT DEFAULT '',                  -- 错误信息
    conversation_id INTEGER,                -- 关联对话ID（可选）
    message_index INTEGER,                  -- 对应消息索引（可选）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);

-- 生成视频记录表索引
CREATE INDEX IF NOT EXISTS idx_gv_user ON generated_videos(user_id);
CREATE INDEX IF NOT EXISTS idx_gv_task ON generated_videos(task_id);
CREATE INDEX IF NOT EXISTS idx_gv_video ON generated_videos(video_id);
CREATE INDEX IF NOT EXISTS idx_gv_status ON generated_videos(status);
