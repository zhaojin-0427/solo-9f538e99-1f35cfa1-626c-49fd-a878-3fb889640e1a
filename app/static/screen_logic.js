/* 投屏端字幕缓存 / 许可逻辑（纯逻辑，页面与 node 测试共用）。
 *
 * 规则：
 *  - 预取响应中的字幕带 license_expiry（服务器时钟），过期即丢弃 → 清屏。
 *  - 响应中的 revoked 列表：立即从缓存移除并加入墓碑集合，永不复播。
 *  - 晚到的旧响应（乱序到达）若仍携带已撤下字幕，墓碑集合会拦截。
 *  - 每场节目有场次代号 generation（重置即换场）：
 *      收到新场次响应时清空上一场的缓存与墓碑，立即切到新场，不刷新页面；
 *      旧场次迟到的回包整体丢弃（不带回旧字幕、不产生确认）。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ScreenLogic = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function createPlayer() {
    return {
      generation: null,     // 当前场次代号；null = 尚未收到任何响应
      broadcastStart: null, // 开播时刻（服务器时钟 epoch 秒）
      cache: new Map(),     // id -> {id, text, start, end, licenseExpiry}
      tombstones: new Set() // 本场已撤下字幕 id：晚到响应/重连都不能复活
    };
  }

  /* 应用一次预取响应；返回需要向服务器确认（ack）的 {id, generation} 列表。
   * 旧场次的迟到回包整体忽略：既不复活旧字幕，也不产生会误伤新场的确认。 */
  function applyPrefetch(player, resp) {
    var gen = resp.generation == null ? 0 : resp.generation;

    // 旧场次的迟到回包（重置后才到达）：整体丢弃
    if (player.generation !== null && gen < player.generation) {
      return [];
    }

    // 新场次（重置后第一次收到当前状态）：清掉上一场全部痕迹，立即切场
    if (player.generation === null || gen > player.generation) {
      player.cache.clear();
      player.tombstones.clear();
      player.generation = gen;
    }

    if (resp.started) {
      player.broadcastStart = resp.now - resp.elapsed;
    } else {
      player.broadcastStart = null; // 新场未开播 → 清屏等待
    }

    var revoked = resp.revoked || [];
    for (var i = 0; i < revoked.length; i++) {
      var id = revoked[i];
      player.tombstones.add(id);
      player.cache.delete(id); // 立即清除该条（若正在播则随即清屏）
    }
    var subs = resp.subtitles || [];
    for (var j = 0; j < subs.length; j++) {
      var raw = subs[j];
      // 服务端字段为下划线命名，归一化为逻辑层统一的驼峰结构（兼容测试用驼峰构造的数据）
      var s = {
        id: raw.id,
        text: raw.text,
        start: raw.start,
        end: raw.end,
        generation: raw.generation,
        licenseExpiry: raw.licenseExpiry != null ? raw.licenseExpiry : raw.license_expiry
      };
      // 双保险：回包内字幕场次与当前场次不一致则不接受
      if (s.generation != null && s.generation !== player.generation) continue;
      if (player.tombstones.has(s.id)) continue; // 晚到响应不能复活已撤下字幕
      var old = player.cache.get(s.id);
      if (old && old.licenseExpiry > s.licenseExpiry) continue; // 晚到的旧响应不缩短已有许可
      player.cache.set(s.id, s);
    }
    return revoked.map(function (rid) { return { id: rid, generation: player.generation }; });
  }

  /* 当前应显示的字幕；serverNow 为服务器时钟的当前时刻（epoch 秒）。
   * 许可过期的条目就地丢弃（断线后许可到期 → 清屏）。 */
  function currentSubtitle(player, serverNow) {
    if (player.broadcastStart === null) return null;
    var elapsed = serverNow - player.broadcastStart;
    var cur = null;
    player.cache.forEach(function (s, id) {
      if (s.licenseExpiry <= serverNow) { player.cache.delete(id); return; }
      if (player.tombstones.has(id)) return;
      if (s.start <= elapsed && elapsed < s.end) cur = s;
    });
    return cur;
  }

  return { createPlayer: createPlayer, applyPrefetch: applyPrefetch, currentSubtitle: currentSubtitle };
});
