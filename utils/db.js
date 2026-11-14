// 宝物数据层。
// 说明：本版本为单机实现（用户未开通云服务），接口形态与云端表访问保持一致，
// 后续开通云服务后只需把 readAll/writeAll 换成 createTableAccess 即可，页面代码不动。
// 硬规则：宝物状态只写数据层，写库成功后才允许改 UI；坐标全程 GCJ-02。
var config = require('./config');
var geo = require('./geo');

function readAll() {
  var list = wx.getStorageSync(config.STORAGE_KEY);
  return Array.isArray(list) ? list : [];
}

function writeAll(list) {
  wx.setStorageSync(config.STORAGE_KEY, list);
}

function getUid() {
  var uid = wx.getStorageSync(config.UID_KEY);
  if (!uid) {
    uid = 'u' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    wx.setStorageSync(config.UID_KEY, uid);
  }
  return uid;
}

function genId() {
  return 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}

// 仅返回埋藏中的宝物（taken 的对全端不可见）
function listBuried() {
  return readAll().filter(function (t) {
    return t.status === 'buried';
  });
}

function get(id) {
  return readAll().find(function (t) {
    return t.id === id;
  }) || null;
}

function insert(rec) {
  var list = readAll();
  var now = Date.now();
  var row = {
    id: genId(),
    name: rec.name,
    riddle: rec.riddle,
    hints: [],
    status: 'buried',
    lng: rec.lng,
    lat: rec.lat,
    photoPath: rec.photoPath || '',
    createdAt: now,
    updatedAt: now,
    creatorUid: getUid(),
    lastOpUid: getUid(),
    takenBy: ''
  };
  list.push(row);
  writeAll(list);
  return row;
}

// 带走：必须落库成功才算数；已被他人带走返回 { ok: false }
function markTaken(id) {
  var list = readAll();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      if (list[i].status !== 'buried') {
        return { ok: false, reason: 'gone' };
      }
      list[i].status = 'taken';
      list[i].takenBy = getUid();
      list[i].lastOpUid = getUid();
      list[i].updatedAt = Date.now();
      writeAll(list);
      return { ok: true, treasure: list[i] };
    }
  }
  return { ok: false, reason: 'missing' };
}

// 继续埋藏：追加一条提示，状态保持 buried
function addHint(id, hint) {
  var list = readAll();
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === id) {
      if (list[i].status !== 'buried') {
        return { ok: false, reason: 'gone' };
      }
      list[i].hints.push({ text: hint, by: getUid(), at: Date.now() });
      list[i].lastOpUid = getUid();
      list[i].updatedAt = Date.now();
      writeAll(list);
      return { ok: true, treasure: list[i] };
    }
  }
  return { ok: false, reason: 'missing' };
}

// 附近查询：v1 全量拉取后前端精筛（宝物数 <500 够用）
// player: [lng, lat]；radius: 发现半径
function nearby(player, radius) {
  return listBuried()
    .map(function (t) {
      return {
        treasure: t,
        distance: geo.dist(player, [t.lng, t.lat])
      };
    })
    .filter(function (n) {
      return n.distance <= radius;
    })
    .sort(function (a, b) {
      return a.distance - b.distance;
    });
}

module.exports = {
  listBuried: listBuried,
  get: get,
  insert: insert,
  markTaken: markTaken,
  addHint: addHint,
  nearby: nearby,
  getUid: getUid
};
