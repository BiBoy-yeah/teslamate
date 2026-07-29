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

pool.on('connect', () => console.log('PostgreSQL connected'));
pool.on('error', (err) => console.error('PostgreSQL error:', err.message));

// ── 健康检查 ──
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── 车辆列表 ──
app.get('/api/cars', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, vin, model, trim_badging, efficiency
      FROM cars ORDER BY id
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 车辆详细信息 ──
app.get('/api/vehicle-info', async (req, res) => {
  const carId = req.query.car_id || 1;
  try {
    const car = await pool.query(`
      SELECT id, name, vin, model, trim_badging, efficiency, 
             insert_date as added_date
      FROM cars WHERE id = $1
    `, [carId]);

    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_drives,
        COALESCE(SUM(end_km - start_km), 0) as total_distance,
        COALESCE(SUM(charge_energy_added), 0) as total_energy_added
      FROM drives d
      LEFT JOIN charging_processes c ON c.car_id = d.car_id
      WHERE d.car_id = $1
    `, [carId]);

    res.json({
      success: true,
      vehicle: car.rows[0] || null,
      stats: stats.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 实时状态 ──
app.get('/api/car-status', async (req, res) => {
  const carId = req.query.car_id || 1;
  try {
    const pos = await pool.query(`
      SELECT battery_level, usable_battery_level, ideal_battery_range_km,
             odometer, speed, latitude, longitude, outside_temp, inside_temp, date
      FROM positions WHERE car_id = $1 ORDER BY date DESC LIMIT 1
    `, [carId]);

    const state = await pool.query(`
      SELECT state, start_date, end_date
      FROM states WHERE car_id = $1 ORDER BY start_date DESC LIMIT 1
    `, [carId]);

    const today = await pool.query(`
      SELECT COALESCE(SUM(end_km - start_km), 0) as today_distance,
             COUNT(*) as today_drives
      FROM drives WHERE car_id = $1 AND start_date > CURRENT_DATE
    `, [carId]);

    res.json({
      success: true,
      position: pos.rows[0] || null,
      state: state.rows[0] || null,
      today_distance: parseFloat(today.rows[0].today_distance || 0),
      today_drives: parseInt(today.rows[0].today_drives || 0)
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 电池历史 ──
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
      WHERE car_id = $1 AND date > NOW() - INTERVAL '${days} days'
        AND battery_level IS NOT NULL
      GROUP BY date_trunc('hour', date)
      ORDER BY time ASC
    `, [carId]);

    res.json({
      success: true, days, count: result.rowCount,
      data: result.rows.map(r => ({
        time: r.time,
        battery_level: parseFloat(r.battery_level),
        usable_battery_level: parseFloat(r.usable_battery_level),
        range_km: parseFloat(r.range_km)
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 最近行程 ──
app.get('/api/recent-drives', async (req, res) => {
  const carId = req.query.car_id || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  try {
    const result = await pool.query(`
      SELECT 
        start_date, end_date,
        ROUND((end_km - start_km)::numeric, 1) AS distance,
        ROUND(duration_min::numeric, 1) AS duration_min,
        ROUND(start_km::numeric, 1) AS start_km,
        ROUND(end_km::numeric, 1) AS end_km
      FROM drives WHERE car_id = $1 ORDER BY start_date DESC LIMIT $2
    `, [carId, limit]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 最近充电 ──
app.get('/api/recent-charges', async (req, res) => {
  const carId = req.query.car_id || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  try {
    const result = await pool.query(`
      SELECT 
        start_date, end_date,
        ROUND(charge_energy_added::numeric, 2) AS energy_added,
        ROUND(charge_energy_used::numeric, 2) AS energy_used,
        ROUND(start_battery_level::numeric, 0) AS start_battery,
        ROUND(end_battery_level::numeric, 0) AS end_battery,
        ROUND(duration_min::numeric, 1) AS duration_min,
        cost
      FROM charging_processes
      WHERE car_id = $1 ORDER BY start_date DESC LIMIT $2
    `, [carId, limit]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 统计汇总（今日/本周/本月/总计）──
app.get('/api/stats-summary', async (req, res) => {
  const carId = req.query.car_id || 1;
  try {
    const today = await pool.query(`
      SELECT COALESCE(SUM(end_km - start_km), 0) as distance,
             COALESCE(SUM(duration_min), 0) as duration
      FROM drives WHERE car_id = $1 AND start_date > CURRENT_DATE
    `, [carId]);

    const week = await pool.query(`
      SELECT COALESCE(SUM(end_km - start_km), 0) as distance,
             COALESCE(SUM(duration_min), 0) as duration,
             COUNT(*) as drive_count
      FROM drives WHERE car_id = $1 AND start_date > NOW() - INTERVAL '7 days'
    `, [carId]);

    const month = await pool.query(`
      SELECT COALESCE(SUM(end_km - start_km), 0) as distance,
             COALESCE(SUM(duration_min), 0) as duration,
             COUNT(*) as drive_count
      FROM drives WHERE car_id = $1 AND start_date > NOW() - INTERVAL '30 days'
    `, [carId]);

    const total = await pool.query(`
      SELECT COALESCE(SUM(end_km - start_km), 0) as distance,
             COALESCE(SUM(duration_min), 0) as duration,
             COUNT(*) as drive_count
      FROM drives WHERE car_id = $1
    `, [carId]);

    const charges = await pool.query(`
      SELECT COALESCE(SUM(charge_energy_added), 0) as energy,
             COALESCE(SUM(cost), 0) as cost,
             COUNT(*) as charge_count
      FROM charging_processes WHERE car_id = $1
    `, [carId]);

    res.json({
      success: true,
      today: { distance: parseFloat(today.rows[0].distance), duration: parseFloat(today.rows[0].duration) },
      week: { distance: parseFloat(week.rows[0].distance), duration: parseFloat(week.rows[0].duration), drives: parseInt(week.rows[0].drive_count) },
      month: { distance: parseFloat(month.rows[0].distance), duration: parseFloat(month.rows[0].duration), drives: parseInt(month.rows[0].drive_count) },
      total: { distance: parseFloat(total.rows[0].distance), duration: parseFloat(total.rows[0].duration), drives: parseInt(total.rows[0].drive_count) },
      charges: { energy: parseFloat(charges.rows[0].energy), cost: parseFloat(charges.rows[0].cost), count: parseInt(charges.rows[0].charge_count) }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 充电效率分析 ──
app.get('/api/charge-efficiency', async (req, res) => {
  const carId = req.query.car_id || 1;
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  try {
    const result = await pool.query(`
      SELECT 
        date_trunc('day', start_date) AS day,
        ROUND(SUM(charge_energy_added)::numeric, 2) AS energy_added,
        ROUND(SUM(charge_energy_used)::numeric, 2) AS energy_used,
        ROUND(AVG(duration_min)::numeric, 1) AS avg_duration,
        COUNT(*) AS charge_count
      FROM charging_processes
      WHERE car_id = $1 AND start_date > NOW() - INTERVAL '${days} days'
      GROUP BY date_trunc('day', start_date)
      ORDER BY day ASC
    `, [carId]);

    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 驾驶统计 ──
app.get('/api/drive-stats', async (req, res) => {
  const carId = req.query.car_id || 1;
  try {
    const result = await pool.query(`
      SELECT 
        ROUND(AVG(end_km - start_km)::numeric, 1) AS avg_distance,
        ROUND(AVG(duration_min)::numeric, 1) AS avg_duration,
        ROUND(MAX(end_km - start_km)::numeric, 1) AS max_distance,
        ROUND(MAX(duration_min)::numeric, 1) AS max_duration,
        COUNT(*) as total_drives
      FROM drives WHERE car_id = $1
    `, [carId]);

    const recent = await pool.query(`
      SELECT 
        start_date,
        ROUND((end_km - start_km)::numeric, 1) AS distance,
        ROUND(duration_min::numeric, 1) AS duration,
        CASE WHEN duration_min > 0 
          THEN ROUND(((end_km - start_km) / NULLIF(duration_min/60, 0))::numeric, 1)
          ELSE 0 END AS avg_speed
      FROM drives WHERE car_id = $1 ORDER BY start_date DESC LIMIT 30
    `, [carId]);

    res.json({
      success: true,
      summary: result.rows[0],
      recent: recent.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 月度统计 ──
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
      WHERE car_id = $1 AND start_date > NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', start_date)
      ORDER BY month DESC
    `, [carId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('TeslaMate Dashboard API running on port ' + PORT);
});
