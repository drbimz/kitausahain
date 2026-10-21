-- ==============================================================================
-- DATABASE SCHEMA & RLS: MULTI-TENANT WEBSITE BUILDER UMKM (VERCEL + SUPABASE)
-- Jalankan query SQL ini di Supabase SQL Editor (Dashboard Supabase -> SQL Editor)
--
-- ARSITEKTUR:
--   * 1 Database Supabase untuk seluruh tenant UMKM.
--   * Multi-tenancy berbasis business_id / slug subdomain.
--   * Data setiap UMKM terisolasi 100% menggunakan Row Level Security (RLS).
--   * Akun 'dapoer-asri' otomatis di-seed sebagai akun demo / percontohan permanen.
--   * Sistem mendukung status 'draft', 'published', dan 'unpublished'.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. TABEL BISNIS / TENANT UMKM (businesses)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.businesses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    slug TEXT UNIQUE NOT NULL,
    business_name TEXT NOT NULL,
    business_subtitle TEXT DEFAULT 'Cita Rasa Masakan Rumah',
    wa_number TEXT DEFAULT '6282226479060',
    status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'unpublished')),
    logo_url TEXT DEFAULT '',
    banner_url TEXT DEFAULT '',
    hero_title TEXT DEFAULT 'Cita Rasa Masakan Rumah Penuh Cinta.',
    hero_desc TEXT DEFAULT 'Olahan bersih, higienis, dan 100% halal khusus untuk keluarga Anda.',
    about_title TEXT DEFAULT 'Kenapa Memilih Kami?',
    about_desc TEXT DEFAULT 'Dapur rumahan higienis yang mengutamakan kualitas rasa dan kesehatan keluarga Anda.',
    kitchen_address TEXT DEFAULT 'Jl. Cempaka Indah No. 12, Kelurahan Asri, Jawa Tengah, Indonesia.',
    operational_hours TEXT DEFAULT 'Senin - Minggu: 08.00 - 18.00 WIB',
    operational_note TEXT DEFAULT 'Pemesanan Pre-Order dibuka setiap hari (H-1)',
    maps_embed_url TEXT DEFAULT '',
    theme_config JSONB DEFAULT '{"primaryColor": "#BA4A24", "secondaryColor": "#2D4F38"}'::jsonb,
    sections_config JSONB DEFAULT '{"hero": true, "features": true, "products": true, "about": true, "promo": true, "location": true}'::jsonb,
    published_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT slug_format_check CHECK (slug ~* '^[a-z0-9]+(-[a-z0-9]+)*$'),
    CONSTRAINT reserved_slug_check CHECK (slug NOT IN ('admin', 'api', 'login', 'register', 'dashboard', 'app', 'www', 'platform', 'public', 'static'))
);

CREATE INDEX IF NOT EXISTS businesses_slug_idx ON public.businesses(slug);
CREATE INDEX IF NOT EXISTS businesses_owner_idx ON public.businesses(owner_id);
CREATE INDEX IF NOT EXISTS businesses_status_idx ON public.businesses(status);

-- Helper: Ambil business_id dari user yang sedang login
CREATE OR REPLACE FUNCTION public.get_current_business_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id FROM public.businesses WHERE owner_id = auth.uid() LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_current_business_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_business_id() TO anon, authenticated;

-- ------------------------------------------------------------------------------
-- 2. TABEL PRODUK / LAYANAN (products) - Terisolasi per business_id
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.products (
    id TEXT NOT NULL,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price NUMERIC NOT NULL DEFAULT 0 CHECK (price >= 0),
    hpp NUMERIC NOT NULL DEFAULT 0 CHECK (hpp >= 0),
    category TEXT DEFAULT 'Snack',
    image TEXT,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (business_id, id)
);

CREATE INDEX IF NOT EXISTS products_business_active_idx ON public.products(business_id, is_active);

-- ------------------------------------------------------------------------------
-- 3. TABEL PESANAN (orders) - Terisolasi per business_id
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.orders (
    id TEXT NOT NULL,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    customer_name TEXT NOT NULL,
    product_name TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1 CHECK (qty >= 1),
    total_price NUMERIC NOT NULL DEFAULT 0 CHECK (total_price >= 0),
    unit_hpp NUMERIC,
    date DATE DEFAULT CURRENT_DATE,
    status TEXT DEFAULT 'Pre-Order' CHECK (status IN ('Pre-Order', 'Diproses', 'Siap Kirim', 'Selesai', 'Dibatalkan')),
    notes TEXT,
    payment_status TEXT DEFAULT 'Lunas',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (business_id, id)
);

CREATE INDEX IF NOT EXISTS orders_business_idx ON public.orders(business_id);
CREATE INDEX IF NOT EXISTS orders_business_date_idx ON public.orders(business_id, date);

-- ------------------------------------------------------------------------------
-- 4. TABEL REKAP KEUANGAN / SETORAN (setoran) - Terisolasi per business_id
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.setoran (
    id TEXT NOT NULL,
    business_id UUID NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
    tanggal DATE DEFAULT CURRENT_DATE,
    nominal NUMERIC NOT NULL DEFAULT 0,
    kategori TEXT DEFAULT 'Setoran Penjualan',
    penerima TEXT DEFAULT 'Kas Utama',
    bukti_foto TEXT,
    catatan TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (business_id, id)
);

CREATE INDEX IF NOT EXISTS setoran_business_idx ON public.setoran(business_id);

-- ------------------------------------------------------------------------------
-- 4b. TABEL PENGATURAN / SETTINGS SISTEM (settings) - Kompatibilitas & Fallback
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read settings" ON public.settings;
CREATE POLICY "Public read settings" ON public.settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "Auth write settings" ON public.settings FOR ALL;
CREATE POLICY "Auth write settings" ON public.settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ------------------------------------------------------------------------------
-- 5. AKUN RESMI: UMMI DAPOER ASRI (ummi@kitausahain.com / password: ummiku)
-- ------------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
DECLARE
    ummi_id UUID;
BEGIN
    -- Cek atau buat user ummi@kitausahain.com di auth.users
    SELECT id INTO ummi_id FROM auth.users WHERE email = 'ummi@kitausahain.com';
    
    IF ummi_id IS NULL THEN
        ummi_id := gen_random_uuid();
        INSERT INTO auth.users (
            instance_id,
            id,
            aud,
            role,
            email,
            encrypted_password,
            email_confirmed_at,
            raw_app_meta_data,
            raw_user_meta_data,
            created_at,
            updated_at
        )
        VALUES (
            '00000000-0000-0000-0000-000000000000',
            ummi_id,
            'authenticated',
            'authenticated',
            'ummi@kitausahain.com',
            crypt('ummiku', gen_salt('bf')),
            NOW(),
            '{"provider":"email","providers":["email"]}'::jsonb,
            '{"business_name":"Dapoer Asri","store_name":"Dapoer Asri","wa_number":"6282226479060"}'::jsonb,
            NOW(),
            NOW()
        );
    ELSE
        -- Update password ummiku dan pastikan status email_confirmed_at aktif
        UPDATE auth.users
        SET encrypted_password = crypt('ummiku', gen_salt('bf')),
            email_confirmed_at = COALESCE(email_confirmed_at, NOW())
        WHERE id = ummi_id;
    END IF;

    -- Tautkan bisnis Dapoer Asri ke akun resmi Ummi
    INSERT INTO public.businesses (
        id, owner_id, slug, business_name, business_subtitle, wa_number, status,
        hero_title, hero_desc, about_title, about_desc
    )
    VALUES (
        '00000000-0000-0000-0000-000000000001',
        ummi_id,
        'dapoer-asri',
        'Dapoer Asri',
        'Ummiku Sayang',
        '6282226479060',
        'published',
        'Cita Rasa Masakan Rumah Penuh Cinta.',
        'Kering kentang balado renyah, salad buah segar kaya vitamin, dan rice bowl hangat khas Dapoer Asri. Olahan bersih, higienis, dan 100% halal khusus untuk keluarga Anda.',
        'Kenapa Memilih Dapoer Asri?',
        'Dapur rumahan higienis yang mengutamakan kualitas rasa dan kesehatan keluarga Anda.'
    )
    ON CONFLICT (slug) DO UPDATE SET
        owner_id = ummi_id,
        status = 'published',
        business_name = EXCLUDED.business_name,
        wa_number = EXCLUDED.wa_number;

END $$;

-- Seed Produk Demo Dapoer Asri
INSERT INTO public.products (id, business_id, name, price, hpp, category, image, description)
VALUES
    ('PRD-1', '00000000-0000-0000-0000-000000000001', 'Kering Kentang Crispy Balado', 25000, 15000, 'Snack', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=600&q=80', 'Kering kentang renyah premium dengan racikan bumbu balado gurih pedas manis khas dapur rumah.'),
    ('PRD-2', '00000000-0000-0000-0000-000000000001', 'Salad Buah Segar Keju', 30000, 18000, 'Dessert', 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=600&q=80', 'Kombinasi aneka buah segar pilihan dengan topping parutan keju melimpah dan saus mayo creamy homemade.'),
    ('PRD-3', '00000000-0000-0000-0000-000000000001', 'Rice Bowl Chicken Mentai', 35000, 20000, 'Main Course', 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=600&q=80', 'Nasi hangat pulen berpadu chicken katsu renyah dilapisi saus mentai gurih yang di-torch sempurna.')
ON CONFLICT (business_id, id) DO NOTHING;

-- Seed Order Demo Dapoer Asri
INSERT INTO public.orders (id, business_id, customer_name, product_name, qty, total_price, unit_hpp, date, status, notes)
VALUES
    ('ORD-001', '00000000-0000-0000-0000-000000000001', 'Ibu Ratna', 'Kering Kentang Crispy Balado', 3, 75000, 15000, CURRENT_DATE, 'Selesai', 'Pedas sedang'),
    ('ORD-002', '00000000-0000-0000-0000-000000000001', 'Bpk. Hendra', 'Rice Bowl Chicken Mentai', 2, 70000, 20000, CURRENT_DATE, 'Diproses', 'Kirim siang')
ON CONFLICT (business_id, id) DO NOTHING;

-- ------------------------------------------------------------------------------
-- 6. ROW LEVEL SECURITY (RLS) - KEAMANAN ISOLASI TENANT MULTI-UMKM
-- ------------------------------------------------------------------------------
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.setoran    ENABLE ROW LEVEL SECURITY;


-- Migration agar tabel businesses lama otomatis memiliki kolom lokasi & jam operasional
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS kitchen_address TEXT DEFAULT 'Jl. Cempaka Indah No. 12, Kelurahan Asri, Jawa Tengah, Indonesia.';
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS operational_hours TEXT DEFAULT 'Senin - Minggu: 08.00 - 18.00 WIB';
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS operational_note TEXT DEFAULT 'Pemesanan Pre-Order dibuka setiap hari (H-1)';
ALTER TABLE public.businesses ADD COLUMN IF NOT EXISTS maps_embed_url TEXT DEFAULT '';

-- BUSINESSES RLS
DROP POLICY IF EXISTS "Public view published businesses" ON public.businesses;
DROP POLICY IF EXISTS "Owner view own business draft" ON public.businesses;
DROP POLICY IF EXISTS "Owner insert business" ON public.businesses;
DROP POLICY IF EXISTS "Owner update business" ON public.businesses;

-- Publik hanya boleh membaca bisnis yang sudah dipublikasikan (published)
CREATE POLICY "Public view published businesses" ON public.businesses
    FOR SELECT TO anon, authenticated
    USING (status = 'published');

-- Pemilik boleh membaca bisnis miliknya sendiri meski masih draft
CREATE POLICY "Owner view own business draft" ON public.businesses
    FOR SELECT TO authenticated
    USING (owner_id = auth.uid());

-- Pemilik boleh membuat bisnis baru
CREATE POLICY "Owner insert business" ON public.businesses
    FOR INSERT TO authenticated
    WITH CHECK (owner_id = auth.uid());

-- Pemilik hanya boleh mengubah bisnis miliknya sendiri
CREATE POLICY "Owner update business" ON public.businesses
    FOR UPDATE TO authenticated
    USING (owner_id = auth.uid())
    WITH CHECK (owner_id = auth.uid());

-- PRODUCTS RLS
DROP POLICY IF EXISTS "Public view active products of published business" ON public.products;
DROP POLICY IF EXISTS "Owner manage products" ON public.products;

-- Publik hanya boleh membaca produk aktif dari bisnis yang sudah published
CREATE POLICY "Public view active products of published business" ON public.products
    FOR SELECT TO anon, authenticated
    USING (
        is_active = true 
        AND business_id IN (SELECT id FROM public.businesses WHERE status = 'published')
    );

-- Pemilik boleh CRUD semua produk di bisnis miliknya sendiri
CREATE POLICY "Owner manage products" ON public.products
    FOR ALL TO authenticated
    USING (business_id = public.get_current_business_id())
    WITH CHECK (business_id = public.get_current_business_id());

-- ORDERS RLS (Hanya pemilik bisnis yang bisa membaca & mengelola pesanan miliknya)
DROP POLICY IF EXISTS "Owner manage orders" ON public.orders;
CREATE POLICY "Owner manage orders" ON public.orders
    FOR ALL TO authenticated
    USING (business_id = public.get_current_business_id())
    WITH CHECK (business_id = public.get_current_business_id());

-- SETORAN RLS (Hanya pemilik bisnis yang bisa membaca & mengelola keuangan miliknya)
DROP POLICY IF EXISTS "Owner manage setoran" ON public.setoran;
CREATE POLICY "Owner manage setoran" ON public.setoran
    FOR ALL TO authenticated
    USING (business_id = public.get_current_business_id())
    WITH CHECK (business_id = public.get_current_business_id());

-- ------------------------------------------------------------------------------
-- 7. TRIGGER OTOMATIS: BUAT BISNIS BARU SAAT USER SIGN-UP
-- ------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user_business()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    new_biz_id UUID;
    biz_title TEXT;
    biz_wa TEXT;
    base_slug TEXT;
    final_slug TEXT;
    counter INT := 0;
BEGIN
    biz_title := COALESCE(NEW.raw_user_meta_data->>'business_name', 'Toko Kuliner');
    biz_wa    := COALESCE(NEW.raw_user_meta_data->>'wa_number', '6282226479060');
    
    base_slug := LOWER(REGEXP_REPLACE(biz_title, '[^a-zA-Z0-9]+', '-', 'g'));
    base_slug := TRIM(BOTH '-' FROM base_slug);
    IF base_slug = '' OR base_slug IN ('admin', 'api', 'login', 'register', 'dashboard', 'app', 'www') THEN 
        base_slug := 'toko'; 
    END IF;
    
    final_slug := base_slug || '-' || SUBSTRING(NEW.id::TEXT FROM 1 FOR 6);

    INSERT INTO public.businesses (owner_id, slug, business_name, wa_number, status)
    VALUES (NEW.id, final_slug, biz_title, biz_wa, 'published')
    RETURNING id INTO new_biz_id;

    -- Berikan template starter produk agar toko langsung siap dipakai
    INSERT INTO public.products (id, business_id, name, price, hpp, category, image, description)
    VALUES
        ('PRD-1', new_biz_id, 'Kering Kentang Crispy Balado', 25000, 15000, 'Snack', 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?auto=format&fit=crop&w=600&q=80', 'Kering kentang renyah bumbu balado gurih pedas manis khas dapur rumah.'),
        ('PRD-2', new_biz_id, 'Salad Buah Segar Keju', 30000, 18000, 'Dessert', 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=600&q=80', 'Aneka buah segar dengan keju melimpah dan saus creamy homemade.')
    ON CONFLICT DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_business();

-- ------------------------------------------------------------------------------
-- 8. STORAGE BUCKET: dapoer-asri (Foto Produk, Logo, Banner)
-- ------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('dapoer-asri', 'dapoer-asri', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
ON CONFLICT (id) DO UPDATE SET
    public = true,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public storage read" ON storage.objects;
DROP POLICY IF EXISTS "Auth storage write" ON storage.objects;

CREATE POLICY "Public storage read" ON storage.objects
    FOR SELECT TO anon, authenticated USING (bucket_id = 'dapoer-asri');

CREATE POLICY "Auth storage write" ON storage.objects
    FOR ALL TO authenticated USING (bucket_id = 'dapoer-asri') WITH CHECK (bucket_id = 'dapoer-asri');
