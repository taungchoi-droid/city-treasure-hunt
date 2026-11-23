-- ============================================================
-- 城市寻宝 · 003 用户资料（昵称 / 头像）
-- ============================================================
-- 设计：
-- 1. 一人一行，主键 user_id = auth.uid()（微信登录生成的 TCB uid）
-- 2. 公开读：宝物详情页的提示（评论）需要展示其他人的昵称与头像
-- 3. 仅本人写：RLS 的 WITH CHECK 限定 user_id = auth.uid()，改不了别人
-- 4. 头像只存云存储路径（shared/avatars/），展示时前端换短时签名 URL
-- 5. 昵称是公开 UGC，写入前在小程序端走与藏宝提示相同的内容审核
-- 全部语句幂等，可在空库上按顺序执行。
-- ============================================================

CREATE TABLE IF NOT EXISTS profiles (
  user_id     TEXT        PRIMARY KEY,
  nickname    TEXT        NOT NULL DEFAULT '',
  avatar_path TEXT        NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE profiles IS '城市寻宝：用户资料（昵称/头像），公开读、仅本人可写';

-- 昵称长度兜底（前端限 12，服务端放宽到 24 防恶意超长撑破界面）
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_nickname_len') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_nickname_len CHECK (char_length(nickname) <= 24);
  END IF;
END
$do$;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- 表级授权：读给所有人（含匿名浏览），写只给已登录用户
GRANT SELECT ON TABLE public.profiles TO anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.profiles TO authenticated;

-- 最小权限：资料行不给客户端删除；TRUNCATE 等与业务无关的权限一并收回
-- （平台的默认授予会带上 DELETE/TRUNCATE，RLS 管不到 TRUNCATE，这里显式收口）
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.profiles FROM authenticated;

-- 所有人可读（评论要显示他人昵称头像）
DROP POLICY IF EXISTS profiles_read_all ON profiles;
CREATE POLICY profiles_read_all ON profiles
  FOR SELECT TO authenticated, anon
  USING (true);

-- 只能插入自己的资料行
DROP POLICY IF EXISTS profiles_insert_own ON profiles;
CREATE POLICY profiles_insert_own ON profiles
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- 只能更新自己的资料行
DROP POLICY IF EXISTS profiles_update_own ON profiles;
CREATE POLICY profiles_update_own ON profiles
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
