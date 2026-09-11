const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../主控台/app.js'), 'utf8');
const fn = source.slice(source.indexOf('async function writeVerifiedCampaign('), source.indexOf('async function writeCampaignRecord('));
function fixture(writeOK, read) {
  const ctx = vm.createContext({JSON, writeBoundText: async () => writeOK, readBoundText: async () => read});
  vm.runInContext(fn, ctx);
  return ctx;
}
test('save success requires exact disk readback', async () => {
  const data = {state: {sharedNotes:'新的内容'}, savedAt: 10};
  await fixture(true, JSON.stringify(data,null,2)).writeVerifiedCampaign('test',data);
});
test('old content returned after successful write is not reported as saved', async () => {
  await assert.rejects(fixture(true,'旧内容').writeVerifiedCampaign('test',{}), /回读校验失败/);
});
test('unreadable file or failed write rejects saving', async () => {
  await assert.rejects(fixture(true,null).writeVerifiedCampaign('test',{}), /回读校验失败/);
  await assert.rejects(fixture(false,null).writeVerifiedCampaign('test',{}), /写入失败/);
});
