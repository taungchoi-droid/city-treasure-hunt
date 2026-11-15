-- ============================================================
-- 城市寻宝 · 后端数据层（WorkBuddy 云服务 / 托管 PostgreSQL）
-- ============================================================
-- 说明：
-- 1. 本文件是云端数据库当前真实结构的完整快照，供版本追溯与换环境重建使用。
-- 2. 云端没有独立的后端服务/Java 代码：数据接口由 PostgREST 风格网关自动暴露，
--    跨用户原子操作（带走/加提示）由下方两个 SECURITY DEFINER 数据库函数承担。
-- 3. 全部语句幂等，可在空库上按顺序执行一遍完成重建。
-- 4. RLS 是唯一安全边界：客户端（authenticated/anon 角色）只有
--    「公开读 + 本人插入」权限，没有任何 UPDATE/DELETE 权限。
-- ============================================================

-- 1. 宝物表：buried/taken 两态，坐标全程 GCJ-02，hints 为 jsonb 数组
CREATE TABLE IF NOT EXISTS treasures (
  id          BIGINT           GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    TEXT             NOT NULL DEFAULT auth.uid(),
  owner_name  TEXT,
  name        TEXT             NOT NULL,
  riddle      TEXT             NOT NULL,
  hints       JSONB            NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT             NOT NULL DEFAULT 'buried',
  lng         DOUBLE PRECISION NOT NULL,
  lat         DOUBLE PRECISION NOT NULL,
  photo_path  TEXT             NOT NULL DEFAULT '',
  taken_by    TEXT             NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);

COMMENT ON TABLE treasures IS '城市寻宝：藏宝点记录，buried/taken 两态，跨用户共享';

-- 2. 开启行级安全
ALTER TABLE treasures ENABLE ROW LEVEL SECURITY;

-- 3. 表级授权：只给客户端读和插，不给 UPDATE/DELETE（防客户端伪造"带走"）
GRANT SELECT, INSERT ON TABLE public.treasures TO authenticated, anon;

-- 4. 行策略：所有用户可读全部宝物（跨用户可见的寻宝体验）
DROP POLICY IF EXISTS treasures_read_all ON treasures;
CREATE POLICY treasures_read_all ON treasures
  FOR SELECT TO authenticated, anon
  USING (true);

-- 5. 行策略：只能插入归属自己的宝物（owner_id 由 DEFAULT auth.uid() 服务端填充，
--    伪造他人 owner_id 会被此策略拒绝）
DROP POLICY IF EXISTS treasures_insert_own ON treasures;
CREATE POLICY treasures_insert_own ON treasures
  FOR INSERT TO authenticated, anon
  WITH CHECK (owner_id = auth.uid());

-- 6. 原子接口：带走宝物（跨用户抢宝由数据库单条 UPDATE 裁决，只有一人成功）
CREATE OR REPLACE FUNCTION take_treasure(p_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  row treasures;
BEGIN
  UPDATE treasures
     SET status = 'taken', taken_by = auth.uid(), updated_at = now()
   WHERE id = p_id AND status = 'buried'
  RETURNING * INTO row;
  IF row.id IS NULL THEN
    PERFORM 1 FROM treasures WHERE id = p_id;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'gone');
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'missing');
  END IF;
  RETURN jsonb_build_object('ok', true);
END
$fn$;

-- 7. 原子接口：追加寻宝提示（状态保持 buried，宝物继续埋）
CREATE OR REPLACE FUNCTION add_treasure_hint(p_id bigint, p_hint text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  row treasures;
BEGIN
  IF length(p_hint) < 1 OR length(p_hint) > 120 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'bad_hint');
  END IF;
  UPDATE treasures
     SET hints = hints || jsonb_build_array(jsonb_build_object('text', p_hint, 'by', auth.uid(), 'at', now())),
         updated_at = now()
   WHERE id = p_id AND status = 'buried'
  RETURNING * INTO row;
  IF row.id IS NULL THEN
    PERFORM 1 FROM treasures WHERE id = p_id;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'gone');
    END IF;
    RETURN jsonb_build_object('ok', false, 'reason', 'missing');
  END IF;
  RETURN jsonb_build_object('ok', true);
END
$fn$;

-- 8. 函数执行权限：收回 PUBLIC，仅授权应用端角色
REVOKE EXECUTE ON FUNCTION take_treasure(bigint), add_treasure_hint(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION take_treasure(bigint), add_treasure_hint(bigint, text) TO authenticated, anon;
