const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ───────────────────────────────────────────────
// PostgreSQL 连接池
// ───────────────────────────────────────────────
const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: process.env.DATABASE_PORT || 5432,
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASS,
  ssl: process.env.DATABASE_SSL === 'true' || process.env.DATABASE_SSL === 'require'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  console.log('PostgreSQL connected');
});

pool.on('error', (err) => {
  console.error('PostgreSQL error:', err.message);
});

// ───────────────────────────────────────────────
// API: 健康检查
// ───────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
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
    console.error('cars error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────
// API: 获取最新车辆状态（实时）
// ───────────────────────────────────────────────
app.get('/api/car-status', async (req, res) => {
  const carId = req.query.car_id || 1;

  try {
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

    const stateResult = await pool.query(`
      SELECT state, start_date, end_date
      FROM states
      WHERE car_id = $1
      ORDER BY start_date DESC
      LIMIT 1
    `, [carId]);

    const driveResult = await pool.query(`
      SELECT COALESCE(SUM(end_km - start_km), 0) AS today_distance
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
    console.error('car-status error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────
// API: 获取电池电量历史（按小时聚合）
// 参数: car_id, days（默认7天，最多90天）
// ───────────────────────────────────────────────
app.get('/api/battery-history', async (req, res) => {
  const carId = req.query.car_id || 1;
  const days = Math.min(parseInt(req.query.days) || 7, 90);

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
    console.error('battery-history error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────
// API: 获取最近行程列表
// 修复：drives 表没有 distance / start_battery_level / end_battery_level 字段
// ───────────────────────────────────────────────
app.get('/api/recent-drives', async (req, res) => {
  const carId = req.query.car_id || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  try {
    const result = await pool.query(`
      SELECT 
        start_date,
        end_date,
        ROUND((end_km - start_km)::numeric, 1) AS distance,
        ROUND(duration_min::numeric, 1) AS duration_min,
        ROUND(start_km::numeric, 1) AS start_km,
        ROUND(end_km::numeric, 1) AS end_km
      FROM drives
      WHERE car_id = $1
      ORDER BY start_date DESC
      LIMIT $2
    `, [carId, limit]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('recent-drives error:', err.message);
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
    console.error('recent-charges error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ───────────────────────────────────────────────
// API: 获取月度统计
// ───────────────────────────────────────────────
app.get('/api/monthly-stats', async (req, res) => {
  const carId = req.query.car_id || 1;

  try {
    const result = await pool.query(`
      SELECT 
        DATE_TRUNC('month', start_date) AS month,
        ROUND(SUM(end_km - start_km)::numeric, 1) AS total_distance,
        ROUND(SUM(duration_min)::numeric, 1) AS total_duration,
        COUNT(*) AS drive_count
      FROM drives
      WHERE car_id = $1
        AND start_date > NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', start_date)
      ORDER BY month DESC
    `, [carId]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error('monthly-stats error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 启动
app.listen(PORT, () => {
  console.log('TeslaMate Dashboard API running on port ' + PORT);
});
