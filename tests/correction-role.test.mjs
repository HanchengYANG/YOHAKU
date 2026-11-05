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

test('历史配置用分句初始化分章，之后可独立保存并兼容旧客户端', async () => {
  const database = new DatabaseSync(':memory:');
  const checkedAt = '2026-11-04';
  const ocr = { providerId: 'openai', model: 'vision' };
  const segmentation = { providerId: 'api_base', model: 'sentences', reasoning: { effort: 'low' } };
  const chaptering = { providerId: 'openai', model: 'chapters', reasoning: { effort: 'high' } };
  const nextSegmentation = { providerId: 'api_base', model: 'sentences-next' };
  const roles = { ocr, correction: ocr, annotation: segmentation, segmentation, chat: ocr };
  const reports = [ocr, segmentation, chaptering, nextSegmentation].map(({model, reasoning}) => ({
    model, reasoning, checkedAt, checks: Object.fromEntries((model === 'vision' ? ['json', 'image', 'streaming'] : ['json'])
      .map(name => [name, { state: 'supported', checkedAt }])),
  }));
  try {
    const config = createRoleConfiguration({ database, ownerId: () => 'owner', preferred: () => 'openai', connection: (_owner, providerId) => ({
      credentialStatus: async () => ({ connected: true, credentialId: providerId }),
      testReports: async () => reports,
      knownModels: async () => reports.map(({model}) => ({ id: model })),
      runtime: { status: () => ({ model: 'vision' }) },
    }) });
    const settings = { annotationReferenceImage: false };
    database.prepare('INSERT INTO ai_role_configurations VALUES(?,?,?,?)').run('owner', 7, JSON.stringify({ roles, ...settings }), checkedAt);
    const migrated = await config.describe();
    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.roles.chaptering, segmentation);
    assert.notEqual(migrated.roles.chaptering, migrated.roles.segmentation);
    assert.equal(migrated.readiness.chaptering.ready, true);
    assert.deepEqual(Object.keys(migrated.readiness.chaptering.report.checks), ['json']);
    await assert.rejects(config.save({ version: 7, ...settings, roles: { ...roles, chaptering: { ...chaptering, model: 'missing' } } }),
      error => error.status === 409 && /分章尚未就绪/.test(error.message));

    const saved = await config.save({ version: 7, ...settings, roles: { ...roles, chaptering } });
    assert.deepEqual(saved.roles.chaptering, chaptering);
    assert.deepEqual(saved.roles.segmentation, segmentation);
    const legacy = await config.save({ version: 8, ...settings, roles: { ...roles, segmentation: nextSegmentation } });
    assert.deepEqual(legacy.roles.chaptering, chaptering);
    assert.deepEqual(legacy.roles.segmentation, nextSegmentation);
    assert.deepEqual(legacy.roles.ocr, ocr);
    assert.deepEqual(config.current().roles.chaptering, chaptering);
  } finally { database.close(); }
});
