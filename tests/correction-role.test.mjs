import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRoleConfiguration } from '../server/ai/roles.mjs';

test('历史四角色配置初次补入校正时复制OCR的提供方、模型与推理选项', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const config = createRoleConfiguration({ database, ownerId: () => 'owner' });
    const ocr = { providerId: 'api_base', model: 'vision', reasoning: { effort: 'low' } };
    database.prepare('INSERT INTO ai_role_configurations VALUES(?,?,?,?)').run('owner', 7, JSON.stringify({ roles: { ocr, annotation: { model: 'text' }, segmentation: { model: 'text' }, chat: { model: 'chat' } }, annotationReferenceImage: false }), '2026-11-04');
    const read = config.current();
    assert.deepEqual(read.roles.correction, ocr);
    assert.equal(read.version, 7);
    assert.notEqual(read.roles.correction, read.roles.ocr);
    read.roles.correction.model = 'independent';
    assert.equal(read.roles.ocr.model, 'vision');
    assert.equal(config.current().roles.correction.model, 'vision');
  } finally { database.close(); }
});
