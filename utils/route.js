// utils/route.js
// 沿道路路线规划：腾讯位置服务 WebService API（步行 / 骑行 / 驾车）
//
// 坐标系说明：腾讯位置服务返回的经纬度就是 GCJ-02，与本项目 map 组件、定位结果、
// 数据库里的宝物坐标全程一致，因此这里不做任何坐标转换，解压后直接交给 polyline。
//
// 启用前置条件（缺一不可）：
//   1) utils/config.js 里填入 TENCENT_MAP_KEY
//   2) 腾讯位置服务控制台：该 Key 勾选「WebServiceAPI」+「微信小程序」，填小程序 AppID，
//      并在「配额管理」中为 Key 分配调用额度（新 Key 默认额度为 0）
//   3) 微信公众平台：开发管理 → 开发设置 → 服务器域名 → request 合法域名
//      添加 https://apis.map.qq.com
//
// 设计原则：任何失败都返回 { ok:false, reason, message }，由调用方降级为直线方位，
// 绝不抛异常、绝不阻塞地图渲染。所有请求都有超时保护，避免弱网时一直转圈。
var config = require('./config');
var geo = require('./geo');

var API_BASE = 'https://apis.map.qq.com/ws/direction/v1/';
var KR = 1000000; // polyline 前向差分的缩放系数

// 常见状态码 -> 给用户看的中文原因；其余状态用接口返回的 message 兜底
var STATUS_HINT = {
  110: '请求来源未被授权：请在该 Key 的控制台勾选「微信小程序」并填写小程序 AppID',
  300: '请求频率超限，请稍后再试',
  310: '请求参数有误，请检查 Key 与起终点坐标',
  311: 'Key 校验失败：请确认 Key 正确、且已开通 WebServiceAPI'
};

// 腾讯位置服务 polyline 解压（官方「前向差分」压缩）：
//   coors[0], coors[1] 是起点的绝对纬度 / 经度；
//   从下标 2 开始，每两项分别是「纬度偏移」「经度偏移」，偏移需除以 1e6，
//   再累加到前一点，得到该点的绝对坐标。
//   例：[39.91522,116.403857,-20,-697] -> 第二点 (39.9152, 116.40316)
function decodePolyline(coors) {
  if (!coors || coors.length < 4 || coors.length % 2 !== 0) return [];
  var arr = [];
  var i;
  for (i = 0; i < coors.length; i++) {
    var n = Number(coors[i]);
    if (!isFinite(n)) return [];
    arr.push(n);
  }
  for (i = 2; i < arr.length; i++) {
    arr[i] = arr[i - 2] + arr[i] / KR;
  }
  var points = [];
  for (i = 0; i < arr.length; i += 2) {
    var lat = arr[i];
    var lng = arr[i + 1];
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    points.push({ latitude: lat, longitude: lng });
  }
  return points;
}

function statusMessage(status, fallback) {
  var hint = STATUS_HINT[status];
  if (hint) return hint + '，已显示直线方位';
  return '路线服务暂不可用（' + (fallback || ('状态码 ' + status)) + '），已显示直线方位';
}

// 项目内部坐标统一 [lng, lat]；接口要求 "lat,lng"
function fmtCoord(p) {
  return p[1].toFixed(6) + ',' + p[0].toFixed(6);
}

/**
 * 规划一条沿道路路线
 * @param {Array} from [lng, lat] 当前位置
 * @param {Array} to   [lng, lat] 宝物位置
 * @returns {Promise<Object>} 成功 { ok:true, points, distance, duration, mode }
 *                            失败 { ok:false, reason, message }
 *                            distance 单位米，duration 单位分钟
 */
function plan(from, to) {
  return new Promise(function (resolve) {
    var key = (config.TENCENT_MAP_KEY || '').trim();
    if (!key) {
      resolve({ ok: false, reason: 'no_key', message: '未配置腾讯位置服务 Key，当前显示直线方位' });
      return;
    }
    if (!from || !to || !isFinite(from[0]) || !isFinite(from[1]) || !isFinite(to[0]) || !isFinite(to[1])) {
      resolve({ ok: false, reason: 'bad_coord', message: '坐标无效，暂时无法规划路线' });
      return;
    }
    // 步行算路要求直线距离 >= 10 米；已经贴近宝物时不必浪费配额
    if (geo.dist(from, to) < 10) {
      resolve({ ok: false, reason: 'too_close', message: '你已非常接近宝物，无需规划路线' });
      return;
    }

    var mode = config.ROUTE_MODE || 'walking';
    var timeoutMs = config.ROUTE_TIMEOUT_MS || 8000;
    var settled = false;
    var timer = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    }

    // 双保险：wx.request 自带 timeout，再挂一个手动超时，
    // 避免个别基础库不支持 timeout 时导航面板一直转圈
    timer = setTimeout(function () {
      finish({ ok: false, reason: 'timeout', message: '路线服务响应超时，已显示直线方位' });
    }, timeoutMs + 1500);

    wx.request({
      url: API_BASE + mode + '/',
      method: 'GET',
      dataType: 'json',
      timeout: timeoutMs,
      data: {
        from: fmtCoord(from),
        to: fmtCoord(to),
        key: key,
        output: 'json'
      },
      success: function (res) {
        var body = res && res.data;
        if (!body || typeof body !== 'object') {
          finish({ ok: false, reason: 'parse', message: '路线服务返回异常，已显示直线方位' });
          return;
        }
        if (body.status !== 0) {
          finish({ ok: false, reason: 'status', message: statusMessage(body.status, body.message) });
          return;
        }
        var route = body.result && body.result.routes && body.result.routes[0];
        var points = route ? decodePolyline(route.polyline) : [];
        if (!route || points.length < 2) {
          finish({ ok: false, reason: 'parse', message: '没有拿到可用的道路路线，已显示直线方位' });
          return;
        }
        finish({
          ok: true,
          points: points,
          distance: Number(route.distance) || 0,
          duration: Number(route.duration) || 0,
          mode: mode
        });
      },
      fail: function (err) {
        var msg = (err && err.errMsg) || '';
        var blocked = /domain|合法域名|url not|not in|ssl/i.test(msg);
        finish({
          ok: false,
          reason: blocked ? 'domain' : 'network',
          message: blocked
            ? '请求被拦截：请在小程序后台把 https://apis.map.qq.com 加入 request 合法域名'
            : '网络异常，暂时无法规划路线，已显示直线方位'
        });
      }
    });
  });
}

// 供 createMapContext().includePoints 使用：点多时均匀抽样，避免一次塞几百个点
function sample(points, max) {
  max = max || 40;
  if (!points || points.length <= max) return points || [];
  var step = Math.ceil(points.length / max);
  var out = [];
  for (var i = 0; i < points.length; i += step) out.push(points[i]);
  var last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

module.exports = { plan: plan, decodePolyline: decodePolyline, sample: sample };
