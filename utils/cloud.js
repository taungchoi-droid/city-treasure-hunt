// WorkBuddy 云服务客户端（全小程序唯一实例）
// 配置取自云服务开通返回的 publicConfig（可安全随前端发布）
// 诊断助手包装 wx：云端请求失败时在 vConsole 打 [WorkBuddy Cloud] request failed
var cloudSdk = require('@tencent-ai/workbuddy-cloud-sdk/miniprogram');
var diag = require('./workbuddy-cloud-diagnostics');

var publicConfig = {
    endpoint: 'https://mp-api.app.workbuddy.host',
    publishableKey: 'wbpk_wCg776qK5eWSNlHWGzTRf0_fCUMFp5qHnjaaGo6knW1LzytBoT1yeXk'
};

var cloud = cloudSdk.createMiniProgramWorkBuddyCloud({
    endpoint: publicConfig.endpoint,
    publishableKey: publicConfig.publishableKey,
    wx: diag.createDiagnosticWx(wx)
});

module.exports = { cloud: cloud, publicConfig: publicConfig };
