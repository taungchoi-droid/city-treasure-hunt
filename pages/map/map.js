// 地图页：原生 <map> + markers + circles + show-location
// 注意：markers 使用数字 id（字符串 id 会导致 markertap 拿错）；每次全量 setData
var config = require('../../utils/config');
var db = require('../../utils/db');
var geo = require('../../utils/geo');
var share = require('../../utils/share');

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
        // 导航专注模式：只显示目标宝物 + 从当前位置到它的直线，隐藏其它所有宝物标志
        navMode: false,
        navTarget: null,      // { id, name, lat, lng }
        navDistText: '',
        navWalkText: '',
        navLoading: false
    },

    onLoad: function (options) {
        share.enable(false);
        this._markerIndex = []; // 数字 id -> treasure.id
        this._lastRefreshAt = 0;
        this._fetching = false;
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
    // 从详情页带 navId 进入：只显示这一个宝物，并用直线连线指向它。
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
            that._navTarget = { id: t.id, name: t.name, lat: t.lat, lng: t.lng };
            that.setData({
                navTarget: { name: t.name },
                navLoading: false,
                navError: '',
                // 目标可能在视野外，先把中心挪过去；拿到定位后再 includePoints 框住两点
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
        this.setData({ navLoading: true, navError: '' });
        this.loadNavTarget();
    },

    // 渲染导航视图：单 marker + 单目标圈 + 起点到终点的直线；持续定位时只更新连线与距离
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

        if (player) {
            var d = geo.dist(player, [t.lng, t.lat]);
            patch.navDistText = geo.fmtDist(d);
            patch.navWalkText = d < config.CLAIM_RADIUS
                ? '已进入 30 米核销范围，可以带走了'
                : '直线方位 · 步行约 ' + Math.max(1, Math.round(d / 80)) + ' 分钟';
            patch.polyline = [{
                points: [
                    { latitude: player[1], longitude: player[0] },
                    { latitude: t.lat, longitude: t.lng }
                ],
                color: '#e8b04b',
                width: 6,
                arrowLine: true
            }];
        } else {
            patch.navDistText = this.data.manualMode ? '未定位' : '定位中…';
            patch.navWalkText = this.data.manualMode
                ? '定位不可用，可点地图右侧「以地图中心定位」手动放出路线'
                : '正在获取你的位置，稍候会自动画出路线';
        }

        this.setData(patch);

        // 首次拿到定位时把「当前位置 + 目标」一起框进视野，之后不再反复跳动地图。
        // 延迟一拍，等 map / markers 这次 setData 渲染完再调 includePoints，否则可能取不到上下文
        if (player && !this._navFramed) {
            this._navFramed = true;
            setTimeout(function () {
                var ctx = wx.createMapContext('treasureMap', that);
                ctx.includePoints({
                    points: [
                        { latitude: player[1], longitude: player[0] },
                        { latitude: t.lat, longitude: t.lng }
                    ],
                    padding: [80, 60, 80, 60],
                    fail: function () { that._navFramed = false; }
                });
            }, 180);
        }
    },

    // 导航中若手动拖动了地图，可重新把「当前位置 + 目标」框回视野
    refocusNav: function () {
        this._navFramed = false;
        this.renderNav();
    },

    // 唤起微信内置地图做真实步行导航（GCJ-02 坐标直接传，无需额外 Key）
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
                wx.showToast({ title: '微信地图打开失败，请按箭头线自行前往', icon: 'none' });
            }
        });
    },

    // 结束导航：恢复普通寻宝视图
    exitNav: function () {
        this._navId = '';
        this._navTarget = null;
        this._navFramed = false;
        this.setData({
            navMode: false,
            navTarget: null,
            navDistText: '',
            navWalkText: '',
            navLoading: false,
            navError: '',
            polyline: [],
            markers: [],
            circles: [],
            scale: config.RADIUS_OPTIONS[this.data.radiusIndex].scale
        });
        this.refreshNearby();
    }
});
