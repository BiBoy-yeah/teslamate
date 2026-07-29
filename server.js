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

// ── 车辆信息 ──
app.get('/api/vehicle-info', async (req, res) => {
  const carId = req.query.car_id || 1;
  try {
    const car = await pool.query(`
      SELECT id, name, vin, model, trim_badging, efficiency, insert_date
      FROM cars WHERE id = $1
    `, [carId]);
    const stats = await pool.query(`
      SELECT 
        COALESCE(SUM(end_km - start_km), 0) as total_distance,
        COALESCE(SUM(charge_energy_added), 0) as total_energy
      FROM drives d
      LEFT JOIN charging_processes c ON c.car_id = d.car_id
      WHERE d.car_id = $1
    `, [carId]);
    res.json({ success: true, vehicle: car.rows[0] || null, stats: stats.rows[0] || null });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 实时状态 + 温度 ──
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

// ── 位置 + 胎压 ──
app.get('/api/location', async (req, res) => {
  const carId = req.query.car_id || 1;
  try {
    let posQuery = `
      SELECT latitude, longitude, outside_temp, inside_temp, date
    `;
    // 尝试查询胎压字段（如果存在）
    try {
      await pool.query(`SELECT tpms_pressure_fl FROM positions LIMIT 1`);
      posQuery = `
        SELECT latitude, longitude, outside_temp, inside_temp, date,
          tpms_pressure_fl, tpms_pressure_fr, tpms_pressure_rl, tpms_pressure_rr
      `;
    } catch(e) {}

    posQuery += ` FROM positions WHERE car_id = $1 ORDER BY date DESC LIMIT 1`;
    const pos = await pool.query(posQuery, [carId]);

    let address = null;
    try {
      const addr = await pool.query(`
        SELECT a.name FROM positions p
        LEFT JOIN addresses a ON p.address_id = a.id
        WHERE p.car_id = $1 ORDER BY p.date DESC LIMIT 1
      `, [carId]);
      if (addr.rows[0]?.name) address = addr.rows[0].name;
    } catch(e) {}

    res.json({ success: true, data: { ...pos.rows[0], address } });
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
    res.json({ success: true, days, count: result.rowCount,
      data: result.rows.map(r => ({
        time: r.time, battery_level: parseFloat(r.battery_level),
        usable_battery_level: parseFloat(r.usable_battery_level),
        range_km: parseFloat(r.range_km)
      }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 上一次驾驶（首页卡片） ──
app.get('/api/last-drive', async (req, res) => {
  const carId = req.query.car_id || 1;
  try {
    const drive = await pool.query(`
      SELECT id, start_date, end_date,
        ROUND((end_km - start_km)::numeric, 1) AS distance,
        ROUND(duration_min::numeric, 1) AS duration_min,
        start_km, end_km
      FROM drives WHERE car_id = $1 ORDER BY start_date DESC LIMIT 1
    `, [carId]);

    if (!drive.rows.length) return res.json({ success: true, data: null });
    const d = drive.rows[0];

    const startBat = await pool.query(`
      SELECT battery_level, ideal_battery_range_km FROM positions
      WHERE car_id = $1 AND date <= $2 ORDER BY date DESC LIMIT 1
    `, [carId, d.start_date]);
    const endBat = await pool.query(`
      SELECT battery_level, ideal_battery_range_km FROM positions
      WHERE car_id = $1 AND date >= $2 ORDER BY date ASC LIMIT 1
    `, [carId, d.end_date]);

    const maxSpeed = await pool.query(`
      SELECT COALESCE(MAX(speed), 0) as max_speed FROM positions
      WHERE car_id = $1 AND date BETWEEN $2 AND $3
    `, [carId, d.start_date, d.end_date]);

    let startAddr = null, endAddr = null;
    try {
      const s = await pool.query(`
        SELECT a.name FROM positions p LEFT JOIN addresses a ON p.address_id = a.id
        WHERE p.car_id = $1 AND p.date >= $2 ORDER BY p.date ASC LIMIT 1
      `, [carId, d.start_date]);
      if (s.rows[0]?.name) startAddr = s.rows[0].name;
    } catch(e) {}
    try {
      const e = await pool.query(`
        SELECT a.name FROM positions p LEFT JOIN addresses a ON p.address_id = a.id
        WHERE p.car_id = $1 AND p.date <= $2 ORDER BY p.date DESC LIMIT 1
      `, [carId, d.end_date]);
      if (e.rows[0]?.name) endAddr = e.rows[0].name;
    } catch(e) {}

    res.json({
      success: true,
      data: {
        ...d,
        start_battery: startBat.rows[0]?.battery_level,
        end_battery: endBat.rows[0]?.battery_level,
        start_range: startBat.rows[0]?.ideal_battery_range_km,
        end_range: endBat.rows[0]?.ideal_battery_range_km,
        max_speed: parseFloat(maxSpeed.rows[0]?.max_speed || 0),
        start_address: startAddr,
        end_address: endAddr
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 驾驶详情 ──
app.get('/api/drive-detail', async (req, res) => {
  const carId = req.query.car_id || 1;
  const driveId = req.query.drive_id;
  if (!driveId) return res.status(400).json({ success: false, error: 'drive_id required' });

  try {
    const drive = await pool.query(`
      SELECT id, start_date, end_date,
        ROUND((end_km - start_km)::numeric, 1) AS distance,
        ROUND(duration_min::numeric, 1) AS duration_min,
        start_km, end_km
      FROM drives WHERE id = $1 AND car_id = $2
    `, [driveId, carId]);

    if (!drive.rows.length) return res.status(404).json({ success: false, error: 'Drive not found' });
    const d = drive.rows[0];

    const startBat = await pool.query(`
      SELECT battery_level, ideal_battery_range_km FROM positions
      WHERE car_id = $1 AND date <= $2 ORDER BY date DESC LIMIT 1
    `, [carId, d.start_date]);
    const endBat = await pool.query(`
      SELECT battery_level, ideal_battery_range_km FROM positions
      WHERE car_id = $1 AND date >= $2 ORDER BY date ASC LIMIT 1
    `, [carId, d.end_date]);

    const maxSpeed = await pool.query(`
      SELECT COALESCE(MAX(speed), 0) as max_speed FROM positions
      WHERE car_id = $1 AND date BETWEEN $2 AND $3
    `, [carId, d.start_date, d.end_date]);

    const avgSpeed = d.duration_min > 0 ? (d.distance / (d.duration_min / 60)) : 0;

    const batHistory = await pool.query(`
      SELECT date, battery_level, ideal_battery_range_km, speed
      FROM positions
      WHERE car_id = $1 AND date BETWEEN $2 AND $3 AND battery_level IS NOT NULL
      ORDER BY date ASC
    `, [carId, d.start_date, d.end_date]);

    let startAddr = null, endAddr = null;
    try {
      const s = await pool.query(`
        SELECT a.name FROM positions p LEFT JOIN addresses a ON p.address_id = a.id
        WHERE p.car_id = $1 AND p.date >= $2 ORDER BY p.date ASC LIMIT 1
      `, [carId, d.start_date]);
      if (s.rows[0]?.name) startAddr = s.rows[0].name;
    } catch(e) {}
    try {
      const e = await pool.query(`
        SELECT a.name FROM positions p LEFT JOIN addresses a ON p.address_id = a.id
        WHERE p.car_id = $1 AND p.date <= $2 ORDER BY p.date DESC LIMIT 1
      `, [carId, d.end_date]);
      if (e.rows[0]?.name) endAddr = e.rows[0].name;
    } catch(e) {}

    res.json({
      success: true,
      data: {
        ...d,
        start_battery: startBat.rows[0]?.battery_level,
        end_battery: endBat.rows[0]?.battery_level,
        start_range: startBat.rows[0]?.ideal_battery_range_km,
        end_range: endBat.rows[0]?.ideal_battery_range_km,
        max_speed: parseFloat(maxSpeed.rows[0]?.max_speed || 0),
        avg_speed: parseFloat(avgSpeed.toFixed(1)),
        start_address: startAddr,
        end_address: endAddr,
        battery_history: batHistory.rows
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 最近行程列表 ──
app.get('/api/recent-drives', async (req, res) => {
  const carId = req.query.car_id || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  try {
    const result = await pool.query(`
      SELECT id, start_date, end_date,
        ROUND((end_km - start_km)::numeric, 1) AS distance,
        ROUND(duration_min::numeric, 1) AS duration_min,
        start_km, end_km
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

// ── 统计汇总 ──
app.get('/api/stats-summary', async (req, res) => {
  const carId = req.query.car_id || 1;
  try {
    const today = await pool.query(`SELECT COALESCE(SUM(end_km - start_km), 0) as distance FROM drives WHERE car_id = $1 AND start_date > CURRENT_DATE`, [carId]);
    const week = await pool.query(`SELECT COALESCE(SUM(end_km - start_km), 0) as distance, COUNT(*) as drives FROM drives WHERE car_id = $1 AND start_date > NOW() - INTERVAL '7 days'`, [carId]);
    const month = await pool.query(`SELECT COALESCE(SUM(end_km - start_km), 0) as distance, COUNT(*) as drives FROM drives WHERE car_id = $1 AND start_date > NOW() - INTERVAL '30 days'`, [carId]);
    const total = await pool.query(`SELECT COALESCE(SUM(end_km - start_km), 0) as distance, COUNT(*) as drives FROM drives WHERE car_id = $1`, [carId]);
    const charges = await pool.query(`SELECT COALESCE(SUM(charge_energy_added), 0) as energy, COUNT(*) as count FROM charging_processes WHERE car_id = $1`, [carId]);

    res.json({
      success: true,
      today: { distance: parseFloat(today.rows[0].distance) },
      week: { distance: parseFloat(week.rows[0].distance), drives: parseInt(week.rows[0].drives) },
      month: { distance: parseFloat(month.rows[0].distance), drives: parseInt(month.rows[0].drives) },
      total: { distance: parseFloat(total.rows[0].distance), drives: parseInt(total.rows[0].drives) },
      charges: { energy: parseFloat(charges.rows[0].energy), count: parseInt(charges.rows[0].count) }
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
      SELECT DATE_TRUNC('month', start_date) AS month,
        ROUND(SUM(end_km - start_km)::numeric, 1) AS total_distance,
        COUNT(*) AS drive_count
      FROM drives WHERE car_id = $1 AND start_date > NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', start_date) ORDER BY month DESC
    `, [carId]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('TeslaMate Dashboard API running on port ' + PORT);
});
