// ==================== Cloudflare D1 HTTP 客户端 ====================
// 用于本地开发时连接云端 D1 数据库

class D1Client {
    constructor(accountId, databaseId, apiToken) {
        this.accountId = accountId;
        this.databaseId = databaseId;
        this.apiToken = apiToken;
        this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
    }

    async request(endpoint, body) {
        const url = `${this.baseUrl}${endpoint}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        const result = await response.json();
        if (!result.success) {
            throw new Error(`D1 API Error: ${JSON.stringify(result.errors)}`);
        }
        return result;
    }

    // 执行查询（SELECT）
    async query(sql, params = []) {
        const result = await this.request('/query', {
            sql,
            params,
        });
        return result.result;
    }

    // 执行语句（INSERT, UPDATE, DELETE, CREATE TABLE）
    async execute(sql, params = []) {
        const result = await this.request('/raw', {
            sql,
            params,
        });
        return result.result;
    }

    // 批量执行多条语句
    async batch(statements) {
        const result = await this.request('/batch', {
            statements,
        });
        return result.result;
    }
}

// 创建兼容 better-sqlite3 接口的 D1 包装器
class D1Wrapper {
    constructor(client) {
        this.client = client;
    }

    // 模拟 db.prepare().all()
    prepare(sql) {
        const client = this.client;
        return {
            all: async (...params) => {
                const result = await client.query(sql, params);
                return result[0]?.results || [];
            },
            get: async (...params) => {
                const result = await client.query(sql, params);
                return result[0]?.results?.[0] || undefined;
            },
            run: async (...params) => {
                const result = await client.execute(sql, params);
                return {
                    changes: result.meta?.changes || 0,
                    lastInsertRowid: result.meta?.last_row_id || 0,
                };
            },
        };
    }

    // 模拟 db.exec()
    async exec(sql) {
        // 分割多条语句
        const statements = sql
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0)
            .map(s => ({ sql: s + ';' }));

        if (statements.length > 0) {
            await this.client.batch(statements);
        }
    }

    // 模拟 db.pragma()
    async pragma(setting) {
        try {
            await this.client.execute(`PRAGMA ${setting}`);
        } catch (e) {
            // D1 可能不支持某些 pragma
            console.log(`Pragma ${setting} skipped (D1 may not support)`);
        }
    }
}

module.exports = { D1Client, D1Wrapper };
