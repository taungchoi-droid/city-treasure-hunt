-- ============================================================
-- 城市寻宝 · 002 收藏功能（个人中心）
-- ============================================================
-- 说明：
-- 1. 收藏是「每个用户自己的私有数据」，与 treasures 的公开读完全不同：
--    只授 authenticated 角色，且三条策略全部限定 owner_id = auth.uid()，
--    任何用户都读不到、改不了别人的收藏。
-- 2. 收藏/取消收藏由客户端直接 INSERT/DELETE 自己的行完成（无跨用户竞争，
--    不需要 SECURITY DEFINER 函数），唯一约束保证同一宝物不会重复收藏。
-- 3. 全部语句幂等，可在 001_init.sql 之后顺序执行。
-- ============================================================

-- 1. 收藏表：一个用户对同一宝物最多一条记录
CREATE TABLE IF NOT EXISTS favorites (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    TEXT        NOT NULL DEFAULT auth.uid(),
  treasure_id BIGINT      NOT NULL REFERENCES treasures(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT favorites_owner_treasure_key UNIQUE (owner_id, treasure_id)
);

COMMENT ON TABLE favorites IS '城市寻宝：用户收藏的宝物，仅本人可见（RLS 限定 owner_id）';

-- 2. 开启行级安全
ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;

-- 3. 表级授权：只给登录用户（匿名不可访问）
GRANT SELECT, INSERT, DELETE ON TABLE public.favorites TO authenticated;

-- 4. 行策略：只能读自己的收藏
DROP POLICY IF EXISTS favorites_read_own ON favorites;
CREATE POLICY favorites_read_own ON favorites
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid());

-- 5. 行策略：只能收藏（插入）自己的记录
DROP POLICY IF EXISTS favorites_insert_own ON favorites;
CREATE POLICY favorites_insert_own ON favorites
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- 6. 行策略：只能取消（删除）自己的收藏
DROP POLICY IF EXISTS favorites_delete_own ON favorites;
CREATE POLICY favorites_delete_own ON favorites
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid());
