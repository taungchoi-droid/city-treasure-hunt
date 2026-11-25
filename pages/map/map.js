// 地图页：原生 <map> + markers + circles + show-location
// 注意：markers 使用数字 id（字符串 id 会导致 markertap 拿错）；每次全量 setData
var config = require('../../utils/config');
var db = require('../../utils/db');
var geo = require('../../utils/geo');
var share = require('../../utils/share');
var route = require('../../utils/route');

var app = getApp();

Page({
    data: {
        viewState: 'loading', // loading / ready / denied
        latitude: 39.9092,    // 兜底中心（北京），真实位置以定位结果为准
        longitude: 116.3974,
        scale: 16,
        markers: [],
        circles: [],
        polyline: [],
        nearbyList: [],
        nearbyCount: 0,
        manualMode: false,
        posLabel: '',
        // 查看范围（滚轮）
        radiusLabels: config.RADIUS_OPTIONS.map(function (o) { return o.label; }),
        radiusIndex: 0,
        // 导航专注模式：只显示目标宝物 + 沿道路路线，隐藏其它所有宝物标志
        navMode: false,
        navTarget: null,      // { name }
        navDistText: '',      // 与宝物的直线距离（实时，用于判断是否进入 30m 核销范围）
        navWalkText: '',      // 沿道路距离 / 预计时长 / 降级说明
        navLoading: false,
        navError: '',
        navRouteState: 'idle',   // idle / loading / ready / fallback
        navRouteHint: ''         // 路线状态说明
    },

    onLoad: function (options) {
        share.enable(false);
        this._markerIndex = []; // 数字 id -> treasure.id
        this._lastRefreshAt = 0;
        this._fetching = false;
        // 沿道路路线缓存：放在页面实例上，不进 data，避免大数组反复 setData
        this._navRoute = null;     // 最近一次成功的路线 { points, distance, duration }
        this._navRouteAt = null;   // 上次算路的 { lnglat, time }，无论成败都记，用于节流
        this._routeFetching = false;
        // 恢复上次的查看范围选择
        var saved = wx.getStorageSync('discover_radius_index');
        if (typeof saved === 'number' && saved >= 0 && saved < config.RADIUS_OPTIONS.length) {
            this.setData({ radiusIndex: saved });
        }
        // 从详情页「导航到这里」进入：带上目标 id，进入专注模式
        this._navId = options && options.navId ? decodeURIComponent(options.navId) : '';
        if (this._navId) {
            this.setData({ navMode: true, navLoading: true });
            this.loadNavTarget();
        }
        this.locate();
    },

    onShareAppMessage: function () {
        return share.homeMessage();
    },

    onUnload: function () {
        if (this._locating) {
            try {
                wx.offLocationChange(this._onLocChange);
                wx.stopLocationUpdate();
            } catch (e) { /* 忽略清理失败 */ }
        }
    },

    /* ---------- 定位 ---------- */
    locate: function () {
        var that = this;
        this.setData({ viewState: 'loading' });
        wx.getLocation({
            type: 'gcj02',
            isHighAccuracy: true,
            success: function (res) {
                that.applyPosition([res.longitude, res.latitude], false);
                that.startLiveLocation();
            },
            fail: function () {
                // 降级：改为手动模式（允许选地图中心点当位置），绝不停在 loading
                that.setData({
                    viewState: 'ready',
                    manualMode: true,
                    posLabel: '定位不可用（未授权 / 模拟器）。拖动地图，点「以地图中心定位」手动放置位置'
                });
                if (that.data.navMode) that.renderNav();
            }
        });
    },

    startLiveLocation: function () {
        var that = this;
        if (this._locating) return;
        wx.startLocationUpdate({
            success: function () {
                that._locating = true;
                that._onLocChange = function (res) {
                    var now = Date.now();
                    // 节流：最多每 4 秒刷新一次附近列表
                    if (now - that._lastRefreshAt < 4000) return;
                    that._lastRefreshAt = now;
                    that.applyPosition([res.longitude, res.latitude], false, true);
                };
                wx.onLocationChange(that._onLocChange);
            },
            fail: function () { /* 拿不到持续定位时退回手动刷新 */ }
        });
    },

    applyPosition: function (lnglat, manual, keepCenter) {
        app.globalData.lastLocation = lnglat;
        this.setData({
            viewState: 'ready',
            manualMode: manual,
            posLabel: manual ? '模拟位置：' + lnglat[0].toFixed(5) + ', ' + lnglat[1].toFixed(5) : ''
        });
        // 导航专注模式：不移动地图中心（交给首次的 includePoints），只刷新路线与距离
        if (this.data.navMode) {
            this.renderNav();
            return;
        }
        if (!keepCenter) {
            this.setData({ latitude: lnglat[1], longitude: lnglat[0] });
        }
        this.refreshNearby();
    },

    /* ---------- 手动兜底：以地图中心为位置 ---------- */
    useMapCenter: function () {
        var that = this;
        var ctx = wx.createMapContext('treasureMap', this);
        ctx.getCenterLocation({
            success: function (res) {
                that.applyPosition([res.longitude, res.latitude], true, true);
                wx.showToast({ title: '已用地图中心定位', icon: 'none' });
            },
            fail: function () {
                wx.showToast({ title: '获取地图中心失败', icon: 'none' });
            }
        });
    },

    openSetting: function () {
        wx.openSetting({});
    },

    /* ---------- 查看范围（滚轮） ---------- */
    onRadiusChange: function (e) {
        if (this.data.navMode) return; // 导航模式下不显示范围滚轮
        var idx = Number(e.detail.value);
        if (isNaN(idx) || idx < 0 || idx >= config.RADIUS_OPTIONS.length) return;
        this.setData({ radiusIndex: idx, scale: config.RADIUS_OPTIONS[idx].scale });
        wx.setStorageSync('discover_radius_index', idx);
        this.refreshNearby();
    },

    // 当前生效的查询半径（不限时用极大值）
    _radius: function () {
        var m = config.RADIUS_OPTIONS[this.data.radiusIndex].meters;
        return m === null ? 1e9 : m;
    },

    /* ---------- 附近宝物 ---------- */
    refreshNearby: function () {
        if (this.data.navMode) { this.renderNav(); return; }
        var player = app.globalData.lastLocation;
        if (!player) {
            this.setData({ markers: [], circles: [], nearbyList: [], nearbyCount: 0 });
            return;
        }
        if (this._fetching) { this._pendingRefresh = true; return; }
        this._fetching = true;
        var that = this;
        db.nearby(player, this._radius()).then(function (near) {
            that._fetching = false;
            that.renderNearby(near);
            if (that._pendingRefresh) {
                that._pendingRefresh = false;
                that.refreshNearby();
            }
        });
    },

    renderNearby: function (near) {
        var markers = [];
        var circles = [];
        var list = [];
        var index = [];

        near.forEach(function (item, i) {
            var t = item.treasure;
            // markers 数字 id：0,1,2…
            markers.push({
                id: i,
                latitude: t.lat,
                longitude: t.lng,
                iconPath: '/assets/icons/pin-buried.png',
                width: 32,
                height: 32,
                callout: {
                    content: t.name,
                    display: 'ALWAYS',
                    padding: 6,
                    borderRadius: 8,
                    bgColor: '#1a1408',
                    color: '#e8b04b',
                    fontSize: 12
                }
            });
            // 模糊范围圈：只画圈，核销点靠玩家自己找
            circles.push({
                latitude: t.lat,
                longitude: t.lng,
                radius: config.BLUR_RADIUS,
                color: '#e8962899',
                fillColor: '#e896281F',
                strokeWidth: 2
            });
            list.push({
                id: t.id,
                name: t.name,
                distText: geo.fmtDist(item.distance)
            });
            index.push(t.id);
        });

        this._markerIndex = index;
        // markers / circles 全量 setData，不逐个更新
        this.setData({ markers: markers, circles: circles, nearbyList: list, nearbyCount: list.length });
    },

    onMarkerTap: function (e) {
        var markerId = e.markerId;
        var treasureId = this._markerIndex[markerId];
        if (treasureId) {
            wx.navigateTo({ url: '/pages/detail/detail?id=' + treasureId });
        }
    },

    onRowTap: function (e) {
        var id = e.currentTarget.dataset.id;
        wx.navigateTo({ url: '/pages/detail/detail?id=' + id });
    },

    goBury: function () {
        wx.navigateTo({ url: '/pages/bury/bury' });
    },

    /* ---------- 导航专注模式 ---------- */
    // 从详情页带 navId 进入：只显示这一个宝物，并规划沿道路步行路线。
    // 其它 markers / 模糊圈 / 附近面板全部隐藏，避免干扰寻路。
    loadNavTarget: function () {
        var that = this;
        db.get(this._navId).then(function (t) {
            if (t && t.__error) {
                that.setData({ navLoading: false, navError: t.message || '宝物加载失败' });
                return;
            }
            if (!t || t.status !== 'buried') {
                wx.showToast({ title: '宝物已不在了', icon: 'none' });
                that.exitNav();
                return;
            }
            var prev = that._navTarget;
            that._navTarget = { id: t.id, name: t.name, lat: t.lat, lng: t.lng };
            // 目标坐标变了就丢掉旧路线，重新规划
            if (prev && (prev.lat !== t.lat || prev.lng !== t.lng)) {
                that._navRoute = null;
                that._navRouteAt = null;
            }
            that.setData({
                navTarget: { name: t.name },
                navLoading: false,
                navError: '',
                // 目标可能在视野外，先把中心挪过去；拿到定位后再 includePoints 框住整条路线
                latitude: t.lat,
                longitude: t.lng
            });
            that.renderNav();
        }).catch(function () {
            that.setData({ navLoading: false, navError: '宝物加载失败，请重试' });
        });
    },

    retryNavTarget: function () {
        if (!this._navId) return;
        this._navRoute = null;
        this._navRouteAt = null;
        this.setData({ navLoading: true, navError: '' });
        this.loadNavTarget();
    },

    // 渲染导航视图：单 marker + 单目标圈 + 沿道路路线；持续定位时只更新线起点与距离
    renderNav: function () {
        if (!this.data.navMode || !this._navTarget) return;
        var t = this._navTarget;
        var player = app.globalData.lastLocation;
        var that = this;

        var markers = [{
            id: 0,
            latitude: t.lat,
            longitude: t.lng,
            iconPath: '/assets/icons/pin-buried.png',
            width: 40,
            height: 40,
            callout: {
                content: t.name,
                display: 'ALWAYS',
                padding: 8,
                borderRadius: 8,
                bgColor: '#1a1408',
                color: '#e8b04b',
                fontSize: 13
            }
        }];
        // 只保留目标自身的模糊圈（提示「接近了」），其它宝物的圈全部清掉
        var circles = [{
            latitude: t.lat,
            longitude: t.lng,
            radius: config.BLUR_RADIUS,
            color: '#e8962899',
            fillColor: '#e896281F',
            strokeWidth: 2
        }];

        this._markerIndex = [t.id];
        var patch = {
            markers: markers,
            circles: circles,
            nearbyList: [],
            nearbyCount: 0,
            polyline: []
        };

        // 沿道路路线：把首点替换成当前位置，让线始终从脚下出发；拿不到路线时降级为直线
        var routeData = this._navRoute;
        var routePoints = null;
        if (routeData && routeData.ok && routeData.points && routeData.points.length > 1) {
            routePoints = routeData.points.slice();
            if (player) routePoints[0] = { latitude: player[1], longitude: player[0] };
        }

        if (player) {
            var d = geo.dist(player, [t.lng, t.lat]);
            patch.navDistText = geo.fmtDist(d);
            if (d < config.CLAIM_RADIUS) {
                patch.navWalkText = '已进入 30 米核销范围，可以带走了';
            } else if (routeData && routeData.ok) {
                var modeText = routeData.mode === 'driving' ? '驾车'
                    : (routeData.mode === 'bicycling' ? '骑行' : '步行');
                patch.navWalkText = '沿道路' + modeText + ' ' + geo.fmtDist(routeData.distance) +
                    ' · 约 ' + Math.max(1, Math.round(routeData.duration)) + ' 分钟';
            } else {
                patch.navWalkText = '直线方位 · 步行约 ' + Math.max(1, Math.round(d / 80)) + ' 分钟';
            }

            if (routePoints) {
                // 实线 + 深色描边更像导航路线；点多时不用 arrowLine，箭头会糊成一片
                patch.polyline = [{
                    points: routePoints,
                    color: '#e8b04b',
                    width: 7,
                    borderColor: '#0f1420',
                    borderWidth: 2
                }];
            } else {
                // 降级：直线方位（arrowLine 只在两点场景使用）
                patch.polyline = [{
                    points: [
                        { latitude: player[1], longitude: player[0] },
                        { latitude: t.lat, longitude: t.lng }
                    ],
                    color: '#e8b04b',
                    width: 6,
                    arrowLine: true
                }];
            }
        } else {
            patch.navDistText = this.data.manualMode ? '未定位' : '定位中…';
            patch.navWalkText = this.data.manualMode
                ? '定位不可用，可点地图右侧「以地图中心定位」手动放出路线'
                : '正在获取你的位置，稍候会自动画出路线';
            patch.polyline = [];
        }

        this.setData(patch);

        // 有定位就尝试规划 / 复用沿道路路线；内部自带节流，不会被持续定位刷爆调用额度
        if (player) this.maybePlanRoute(player);

        // 首次拿到定位时把整条路线框进视野（道路会绕行，不能只框起终点）。
        // 延迟一拍，等 map / markers 这次 setData 渲染完再调 includePoints，否则可能取不到上下文
        if (player && !this._navFramed) {
            this._navFramed = true;
            setTimeout(function () {
                var pts = routePoints
                    ? route.sample(routePoints, 40)
                    : [
                        { latitude: player[1], longitude: player[0] },
                        { latitude: t.lat, longitude: t.lng }
                    ];
                var ctx = wx.createMapContext('treasureMap', that);
                ctx.includePoints({
                    points: pts,
                    padding: [90, 70, 90, 70],
                    fail: function () { that._navFramed = false; }
                });
            }, 180);
        }
    },

    /* ---------- 沿道路路线规划（腾讯位置服务） ---------- */
    // 只在「进入导航 / 位置明显移动 / 手动重新规划」时请求接口，其余时刻复用已有路线，
    // 避免持续定位每 4 秒一次把 WebService 调用额度刷爆。
    maybePlanRoute: function (player) {
        if (!this._navTarget || this._routeFetching) return;
        var key = (config.TENCENT_MAP_KEY || '').trim();
        if (!key) {
            // 持续定位会反复调用 renderNav，这里只在状态变化时 setData，避免无谓刷新
            if (this.data.navRouteState !== 'fallback') {
                this.setData({
                    navRouteState: 'fallback',
                    navRouteHint: '未配置腾讯位置服务 Key，当前显示直线方位；填入 Key 后会自动切换为沿道路路线'
                });
            }
            return;
        }
        var to = [this._navTarget.lng, this._navTarget.lat];
        var prev = this._navRouteAt;
        var now = Date.now();
        // 成败都记 _navRouteAt：失败后同样进入冷却，避免自动无限重试
        if (prev) {
            var moved = geo.dist(prev.lnglat, player);
            var elapsed = now - prev.time;
            if (moved < (config.ROUTE_REPLAN_DIST || 100) &&
                elapsed < (config.ROUTE_REPLAN_MIN_MS || 30000)) {
                return; // 复用已有路线，仅更新线的起点与直线距离
            }
        }
        if (geo.dist(player, to) < 10) return; // 已在宝物跟前，无需算路
        this.requestRoute(player, to);
    },

    requestRoute: function (from, to) {
        if (this._routeFetching) return;
        var that = this;
        this._routeFetching = true;
        this.setData({
            navRouteState: 'loading',
            navRouteHint: '正在向腾讯位置服务请求沿道路路线…'
        });
        route.plan(from, to).then(function (result) {
            that._routeFetching = false;
            // 导航已退出 / 目标已变：丢弃迟到的结果
            if (!that.data.navMode || !that._navTarget) return;
            that._navRouteAt = { lnglat: from, time: Date.now() };
            if (result.ok) {
                that._navRoute = result;
                that.setData({
                    navRouteState: 'ready',
                    navRouteHint: '已按步行道路规划路线'
                });
            } else {
                that._navRoute = null;
                that.setData({
                    navRouteState: 'fallback',
                    navRouteHint: result.message
                });
            }
            that.renderNav();
        }).catch(function () {
            that._routeFetching = false;
            if (!that.data.navMode) return;
            that._navRoute = null;
            that._navRouteAt = { lnglat: from, time: Date.now() };
            that.setData({
                navRouteState: 'fallback',
                navRouteHint: '路线规划异常，已显示直线方位'
            });
            that.renderNav();
        });
    },

    // 手动强制重算（配置好 Key / 恢复网络后点一下即可）
    replanRoute: function () {
        var player = app.globalData.lastLocation;
        if (!this.data.navMode || !this._navTarget) return;
        if (!player) {
            wx.showToast({ title: '还没拿到你的位置，稍后再试', icon: 'none' });
            return;
        }
        if (!(config.TENCENT_MAP_KEY || '').trim()) {
            wx.showToast({ title: '请先在配置里填腾讯位置服务 Key', icon: 'none' });
            return;
        }
        this._navRoute = null;
        this._navRouteAt = null;
        this.requestRoute(player, [this._navTarget.lng, this._navTarget.lat]);
    },

    // 导航中若手动拖动了地图，可重新把整条路线框回视野
    refocusNav: function () {
        this._navFramed = false;
        this.renderNav();
    },

    // 唤起微信内置地图做语音步行导航（GCJ-02 坐标直接传，openLocation 本身不需要 Key）
    openWxNav: function () {
        var t = this._navTarget;
        if (!t) return;
        wx.openLocation({
            latitude: t.lat,
            longitude: t.lng,
            name: t.name,
            address: '城市寻宝 · 宝物大致位置',
            scale: 18,
            fail: function (e) {
                console.warn('[Map] openLocation failed', e && e.errMsg ? e.errMsg : '');
                wx.showToast({ title: '微信地图打开失败，请按路线自行前往', icon: 'none' });
            }
        });
    },

    // 结束导航：恢复普通寻宝视图
    exitNav: function () {
        this._navId = '';
        this._navTarget = null;
        this._navFramed = false;
        this._navRoute = null;
        this._navRouteAt = null;
        this._routeFetching = false;
        this.setData({
            navMode: false,
            navTarget: null,
            navDistText: '',
            navWalkText: '',
            navLoading: false,
            navError: '',
            navRouteState: 'idle',
            navRouteHint: '',
            polyline: [],
            markers: [],
            circles: [],
            scale: config.RADIUS_OPTIONS[this.data.radiusIndex].scale
        });
        this.refreshNearby();
    }
});
