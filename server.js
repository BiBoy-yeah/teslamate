const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 允许跨域（如果你的前端和后端域名不同）
app.use(cors());

// 静态文件服务（前端页面）
app.use(express.static('public'));

// ───────────────────────────────────────────────
// PostgreSQL 连接池
// 从环境变量读取，兼容 Railway 和本地开发
// ───────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: process.env.DATABASE_PORT || 5432,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASS,
  // Railway PostgreSQL 通常需要 SSL
  ssl: process.env.DATABASE_SSL === 'true' || process.env.DATABASE_SSL === 'require'
    ? { rejectUnauthorized: false }
    : false,
  // 连接池配置
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 测试数据库连接
pool.on('connect', () => {
  console.log('✅ PostgreSQL 已连接');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL 连接错误:', err.message);
});

// ───────────────────────────────────────────────
// API: 获取车辆列表
// ───────────────────────────────────────────────
app.get('/api/cars', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, vin, model, trim_badging, efficiency
      FROM cars
      ORDER BY id
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('获取车辆列表失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────
// API: 获取电池电量历史（按小时聚合，减少数据点）
// 参数: car_id, days（默认7天）
// ───────────────────────────────────────────────
app.get('/api/battery-history', async (req, res) => {
  const carId = req.query.car_id || 1;
  const days = Math.min(parseInt(req.query.days) || 7, 90); // 最多90天

  try {
    const result = await pool.query(`
      SELECT 
        date_trunc('hour', date) AS time,
        ROUND(AVG(battery_level)::numeric, 1) AS battery_level,
        ROUND(AVG(usable_battery_level)::numeric, 1) AS usable_battery_level,
        ROUND(AVG(ideal_battery_range_km)::numeric, 1) AS range_km
      FROM positions
      WHERE car_id = $1
        AND date > NOW() - INTERVAL '${days} days'
        AND battery_level IS NOT NULL
      GROUP BY date_trunc('hour', date)
      ORDER BY time ASC
    `, [carId]);

    res.json({
      success: true,
      days: days,
      count: result.rowCount,
      data: result.rows.map(row => ({
        time: row.time,
        battery_level: parseFloat(row.battery_level),
        usable_battery_level: parseFloat(row.usable_battery_level),
        range_km: parseFloat(row.range_km)
      }))
    });
  } catch (err) {
    console.error('获取电池历史失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────
// API: 获取最新车辆状态（实时）
// ───────────────────────────────────────────────
app.get('/api/car-status', async (req, res) => {
  const carId = req.query.car_id || 1;

  try {
    // 最新位置数据
    const posResult = await pool.query(`
      SELECT 
        battery_level,
        usable_battery_level,
        ideal_battery_range_km,
        odometer,
        speed,
        latitude,
        longitude,
        outside_temp,
        inside_temp,
        date
      FROM positions
      WHERE car_id = $1
      ORDER BY date DESC
      LIMIT 1
    `, [carId]);

    // 最新状态
    const stateResult = await pool.query(`
      SELECT state, start_date, end_date
      FROM states
      WHERE car_id = $1
      ORDER BY start_date DESC
      LIMIT 1
    `, [carId]);

    // 今日行驶里程
    const driveResult = await pool.query(`
      SELECT COALESCE(SUM(distance), 0) AS today_distance
      FROM drives
      WHERE car_id = $1
        AND start_date > CURRENT_DATE
    `, [carId]);

    res.json({
      success: true,
      position: posResult.rows[0] || null,
      state: stateResult.rows[0] || null,
      today_distance: parseFloat(driveResult.rows[0]?.today_distance || 0)
    });
  } catch (err) {
    console.error('获取车辆状态失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────
// API: 获取最近行程列表
// ───────────────────────────────────────────────
app.get('/api/recent-drives', async (req, res) => {
  const carId = req.query.car_id || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  try {
    const result = await pool.query(`
      SELECT 
        start_date,
        end_date,
        ROUND(distance::numeric, 1) AS distance,
        ROUND(duration_min::numeric, 1) AS duration_min,
        ROUND(start_km::numeric, 1) AS start_km,
        ROUND(end_km::numeric, 1) AS end_km,
        ROUND(start_battery_level::numeric, 0) AS start_battery,
        ROUND(end_battery_level::numeric, 0) AS end_battery
      FROM drives
      WHERE car_id = $1
      ORDER BY start_date DESC
      LIMIT $2
    `, [carId, limit]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('获取行程失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────
// API: 获取最近充电记录
// ───────────────────────────────────────────────
app.get('/api/recent-charges', async (req, res) => {
  const carId = req.query.car_id || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  try {
    const result = await pool.query(`
      SELECT 
        start_date,
        end_date,
        ROUND(charge_energy_added::numeric, 2) AS energy_added,
        ROUND(charge_energy_used::numeric, 2) AS energy_used,
        ROUND(start_battery_level::numeric, 0) AS start_battery,
        ROUND(end_battery_level::numeric, 0) AS end_battery,
        ROUND(duration_min::numeric, 1) AS duration_min,
        cost
      FROM charging_processes
      WHERE car_id = $1
      ORDER BY start_date DESC
      LIMIT $2
    `, [carId, limit]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('获取充电记录失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────
// 健康检查
// ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// 启动服务
app.listen(PORT, () => {
  console.log(`🚗 TeslaMate Dashboard API 已启动`);
  console.log(`📡 端口: ${PORT}`);
  console.log(`🌐 访问: http://localhost:${PORT}`);
});
