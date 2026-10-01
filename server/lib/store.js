/* PaperPilot 账号后台 · JSON 原子存储
 * users.json / channels.json：读时容错（损坏→备份后重建），写时 tmp+rename 原子替换。
 * 单进程串行写（管理操作低频），无需锁。
 */
'use strict';

const fs = require('fs');
const path = require('path');

class JsonStore {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
    this.data = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const doc = JSON.parse(raw);
      if (doc && typeof doc === 'object') return doc;
    } catch (e) {
      if (e && e.code === 'ENOENT') return JSON.parse(JSON.stringify(this.fallback));
      // 损坏：备份现场后回退默认值（绝不因一个坏文件起不来）
      try {
        fs.copyFileSync(this.file, this.file + '.corrupt-' + Date.now());
      } catch (_) { /* ignore */ }
      console.error('[store] %s damaged, fallback to default (backup kept): %s',
        path.basename(this.file), e.message);
      return JSON.parse(JSON.stringify(this.fallback));
    }
    return JSON.parse(JSON.stringify(this.fallback));
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { JsonStore };
