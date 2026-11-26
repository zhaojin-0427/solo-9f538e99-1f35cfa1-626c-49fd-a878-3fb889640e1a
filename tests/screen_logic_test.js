/* 投屏端缓存/许可逻辑测试（node tests/screen_logic_test.js） */
"use strict";
const L = require("../app/static/screen_logic.js");
let failed = 0;
function check(name, cond) {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}`);
  if (!cond) failed++;
}
function ackIds(acks) { return acks.map(function (a) { return a.id; }); }

// A. 断线后续播 + 许可到期清屏
{
  const p = L.createPlayer();
  L.applyPrefetch(p, { started: true, now: 1000, elapsed: 0, generation: 1, revoked: [],
    subtitles: [{ id: 1, text: "甲", start: 2, end: 8, generation: 1, licenseExpiry: 1005 }] });
  check("断线后许可期内按原时段续播", (L.currentSubtitle(p, 1003) || {}).text === "甲");
  check("时段前不显示", L.currentSubtitle(p, 1001) === null);
  check("许可到期即清屏", L.currentSubtitle(p, 1005.5) === null);
  check("过期条目从缓存移除", p.cache.size === 0);
}

// B. 撤下：立即清除 + 晚到响应不复活 + 其他字幕照常
{
  const p = L.createPlayer();
  const staleResp = { started: true, now: 1000, elapsed: 0, generation: 1, revoked: [], subtitles: [
    { id: 1, text: "甲", start: 2, end: 8, generation: 1, licenseExpiry: 1005 },
    { id: 2, text: "乙", start: 10, end: 16, generation: 1, licenseExpiry: 1005 }] };
  L.applyPrefetch(p, staleResp);
  const acks = L.applyPrefetch(p, { started: true, now: 1001, elapsed: 1, generation: 1, revoked: [1], subtitles: [
    { id: 2, text: "乙", start: 10, end: 16, generation: 1, licenseExpiry: 1020 }] });
  check("撤下后需向服务器确认该条（带场次）", ackIds(acks).join(",") === "1" && acks[0].generation === 1);
  check("该条立即从缓存清除", !p.cache.has(1));
  check("撤下后该条不再显示", L.currentSubtitle(p, 1003) === null);
  L.applyPrefetch(p, staleResp); // 晚到的旧响应（仍携带 #1）
  check("晚到响应不能复活已撤下字幕", !p.cache.has(1) && L.currentSubtitle(p, 1003) === null);
  check("其他字幕照常播放", (L.currentSubtitle(p, 1011) || {}).text === "乙");
}

// C. 许可到期后重连：收到撤下通知需确认，且不复播
{
  const p = L.createPlayer();
  L.applyPrefetch(p, { started: true, now: 1000, elapsed: 0, generation: 1, revoked: [],
    subtitles: [{ id: 1, text: "甲", start: 2, end: 8, generation: 1, licenseExpiry: 1005 }] });
  const acks = L.applyPrefetch(p, { started: true, now: 1006, elapsed: 6, generation: 1, subtitles: [], revoked: [1] });
  check("重连收到撤下通知需确认", ackIds(acks).join(",") === "1");
  check("重连后该条不复播", L.currentSubtitle(p, 1006.5) === null);
}

// D. 未开播
{
  const p = L.createPlayer();
  L.applyPrefetch(p, { started: false, now: 1000, generation: 1, subtitles: [], revoked: [] });
  check("未开播不显示", L.currentSubtitle(p, 1001) === null);
  check("未开播时开播时刻为空（清屏等待）", p.broadcastStart === null);
}

// D2. 服务端下划线字段（license_expiry）归一化：真实接口字段名，许可到期必须能清屏
{
  const p = L.createPlayer();
  L.applyPrefetch(p, { started: true, now: 1000, elapsed: 0, generation: 1, revoked: [],
    subtitles: [{ id: 1, text: "甲", start: 2, end: 8, generation: 1, license_expiry: 1005 }] });
  check("下划线字段被归一化并缓存", p.cache.has(1) && p.cache.get(1).licenseExpiry === 1005);
  check("真实字段名下许可期内可播", (L.currentSubtitle(p, 1003) || {}).text === "甲");
  check("真实字段名下许可到期清屏", L.currentSubtitle(p, 1005.5) === null);
}

// E. 重置切场：收到新场次响应即清空旧缓存/墓碑并切场，无需刷新
{
  const p = L.createPlayer();
  // 第一场：#1 已撤下（墓碑），#2 在缓存中
  L.applyPrefetch(p, { started: true, now: 1000, elapsed: 0, generation: 1, revoked: [],
    subtitles: [
      { id: 1, text: "旧场甲", start: 2, end: 8, generation: 1, licenseExpiry: 1005 },
      { id: 2, text: "旧场乙", start: 10, end: 16, generation: 1, licenseExpiry: 1005 }] });
  L.applyPrefetch(p, { started: true, now: 1001, elapsed: 1, generation: 1, revoked: [1], subtitles: [] });
  check("旧场撤下后 #1 进墓碑", p.tombstones.has(1) && !p.cache.has(1));
  check("旧场 #2 仍在缓存", p.cache.has(2));

  // 重置后投屏收到的第一帧：新场次、未开播 → 立即清屏等待
  const acksOnSwitch = L.applyPrefetch(p, { started: false, now: 1010, generation: 2, subtitles: [], revoked: [] });
  check("切场后场次代号更新", p.generation === 2);
  check("切场即清空旧缓存", p.cache.size === 0);
  check("切场即清空旧墓碑", p.tombstones.size === 0);
  check("切场未开播 → 清屏", L.currentSubtitle(p, 1011) === null && p.broadcastStart === null);
  check("切场帧不产生旧场确认", acksOnSwitch.length === 0);

  // 新场开播：同号 #1 是全新字幕，应正常缓存与播放，不被旧墓碑挡住
  L.applyPrefetch(p, { started: true, now: 1020, elapsed: 0, generation: 2, revoked: [],
    subtitles: [{ id: 1, text: "新场甲", start: 2, end: 8, generation: 2, licenseExpiry: 1025 }] });
  check("新场同号字幕不被旧墓碑挡住", (L.currentSubtitle(p, 1023) || {}).text === "新场甲");
}

// F. 旧场次迟到的预取回包：整体丢弃，不带回旧字幕、不产生确认
{
  const p = L.createPlayer();
  L.applyPrefetch(p, { started: true, now: 1020, elapsed: 0, generation: 2, revoked: [],
    subtitles: [{ id: 1, text: "新场甲", start: 2, end: 8, generation: 2, licenseExpiry: 1025 }] });
  const lateOld = { started: true, now: 1005, elapsed: 5, generation: 1, revoked: [2], subtitles: [
    { id: 1, text: "旧场甲", start: 2, end: 8, generation: 1, licenseExpiry: 1010 },
    { id: 3, text: "旧场丙", start: 6, end: 9, generation: 1, licenseExpiry: 1010 }] };
  const acks = L.applyPrefetch(p, lateOld);
  check("旧场次回包不产生确认", acks.length === 0);
  check("旧场次回包不带回旧字幕", p.cache.size === 1 && (p.cache.get(1) || {}).text === "新场甲");
  check("旧场次回包不写入旧墓碑", !p.tombstones.has(2));
  check("旧场次回包不改变当前场次与播放时序",
    p.generation === 2 && (L.currentSubtitle(p, 1023) || {}).text === "新场甲");

  // 当前场次的正常响应照常工作
  L.applyPrefetch(p, { started: true, now: 1021, elapsed: 1, generation: 2, revoked: [], subtitles: [
    { id: 1, text: "新场甲", start: 2, end: 8, generation: 2, licenseExpiry: 1030 }] });
  check("当前场次响应照常接受", p.cache.get(1).licenseExpiry === 1030);
}

// G. 无代号的旧响应按代号 0 处理，不会污染新场次
{
  const p = L.createPlayer();
  L.applyPrefetch(p, { started: true, now: 1020, elapsed: 0, generation: 3, revoked: [],
    subtitles: [{ id: 1, text: "新场甲", start: 2, end: 8, generation: 3, licenseExpiry: 1025 }] });
  const acks = L.applyPrefetch(p, { started: true, now: 900, elapsed: 0, revoked: [1], subtitles: [
    { id: 1, text: "无代号旧甲", start: 2, end: 8, licenseExpiry: 905 }] });
  check("无代号回包视为旧场次，整体丢弃", acks.length === 0 && (p.cache.get(1) || {}).text === "新场甲");
}

console.log(failed ? `== ${failed} 项失败 ==` : "== 全部通过 ==");
process.exit(failed ? 1 : 0);
