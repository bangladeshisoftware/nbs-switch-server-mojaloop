const { pool } = require('../config/db');
const ExcelJS  = require('exceljs');


function buildFilters(query) {
  const { date_preset, from, to, dfsp, direction, status } = query;
  const conditions = [];
  const values     = [];

  // ── Date filter ───────────────────────────────────────────
  if (date_preset === 'today') {
    conditions.push(`DATE(t.created_at) = CURDATE()`);
  } else if (date_preset === 'yesterday') {
    conditions.push(`DATE(t.created_at) = CURDATE() - INTERVAL 1 DAY`);
  } else if (date_preset === 'this_week') {
    conditions.push(`t.created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)`);
  } else if (from && to) {
    conditions.push(`DATE(t.created_at) BETWEEN ? AND ?`);
    values.push(from, to);
  } else if (from) {
    conditions.push(`DATE(t.created_at) >= ?`);
    values.push(from);
  }


  if (dfsp) {
    if (direction === 'SEND') {
      conditions.push(`t.payer_fsp = ?`);
      values.push(dfsp);
    } else if (direction === 'RECEIVE') {
      conditions.push(`t.payee_fsp = ?`);
      values.push(dfsp);
    } else {
      conditions.push(`(t.payer_fsp = ? OR t.payee_fsp = ?)`);
      values.push(dfsp, dfsp);
    }
  }

  if (status && status !== 'ALL') {
    conditions.push(`t.status = ?`);
    values.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, values };
}

exports.getReportData = async (req, res) => {
  try {
    const { where, values } = buildFilters(req.query);

    const [transfers] = await pool.execute(`
      SELECT
        t.transfer_id,
        t.payer_fsp,
        t.payee_fsp,
        t.amount,
        t.currency,
        t.status,
        t.created_at,
        t.completed_at,
        TIMESTAMPDIFF(SECOND, t.created_at, t.completed_at) AS duration_sec
      FROM transfers t
      ${where}
      ORDER BY t.created_at DESC
      LIMIT 5000`,
      values
    );

    const [summary] = await pool.execute(`
      SELECT
        COUNT(*)                                          AS total,
        SUM(t.status = 'COMMITTED')                      AS committed,
        SUM(t.status = 'RESERVED')                       AS reserved,
        SUM(t.status = 'RECEIVED')                       AS prepared,
        SUM(t.status = 'FAILED')                         AS failed,
        SUM(t.status = 'TIMEOUT')                        AS timeout,
        SUM(CASE WHEN t.status = 'COMMITTED' THEN t.amount ELSE 0 END) AS total_amount,
        COUNT(DISTINCT t.currency)                        AS currencies,
        COUNT(DISTINCT t.payer_fsp)                       AS payer_count,
        COUNT(DISTINCT t.payee_fsp)                       AS payee_count
      FROM transfers t
      ${where}`,
      values
    );

    res.json({
      summary: summary[0],
      data:    transfers,
      count:   transfers.length,
      filters: req.query,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.exportExcel = async (req, res) => {
  try {
    const { where, values } = buildFilters(req.query);

    const [transfers] = await pool.execute(`
      SELECT
        t.transfer_id,
        t.payer_fsp,
        t.payee_fsp,
        t.amount,
        t.currency,
        t.status,
        t.ilp_condition,
        t.created_at,
        t.completed_at,
        TIMESTAMPDIFF(SECOND, t.created_at, t.completed_at) AS duration_sec
      FROM transfers t
      ${where}
      ORDER BY t.created_at DESC
      LIMIT 50000`,
      values
    );

    const [summary] = await pool.execute(`
      SELECT
        COUNT(*)                                          AS total,
        SUM(t.status = 'COMMITTED')                      AS committed,
        SUM(t.status = 'RESERVED')                       AS reserved,
        SUM(t.status = 'RECEIVED')                       AS prepared,
        SUM(t.status = 'FAILED')                         AS failed,
        SUM(t.status = 'TIMEOUT')                        AS timeout,
        SUM(CASE WHEN t.status = 'COMMITTED' THEN t.amount ELSE 0 END) AS total_amount,
        AVG(CASE WHEN t.status = 'COMMITTED'
          THEN TIMESTAMPDIFF(SECOND, t.created_at, t.completed_at) END) AS avg_duration
      FROM transfers t
      ${where}`,
      values
    );
    const s = summary[0];

 
    const wb = new ExcelJS.Workbook();
    wb.creator  = 'R Switch Portal';
    wb.created  = new Date();

    const C = {
      headerBg:  '1A1A2E',
      headerFg:  'FFFFFF',
      accentBg:  '00FF00',
      accentFg:  '000000',
      committed: 'D4EDDA',
      failed:    'F8D7DA',
      reserved:  'FFF3CD',
      prepared:  'D1ECF1',
      altRow:    'F8F9FA',
      summaryBg: '0D0D0D',
    };

    const summary_sheet = wb.addWorksheet('Summary', {
      properties: { tabColor: { argb: 'FF00FF00' } },
    });

    summary_sheet.columns = [
      { width: 30 }, { width: 25 }, { width: 20 },
    ];

    // Title
    summary_sheet.mergeCells('A1:C1');
    const titleCell = summary_sheet.getCell('A1');
    titleCell.value     = '⬡ R SWITCH PORTAL — Transfer Report';
    titleCell.font      = { bold: true, size: 16, color: { argb: 'FF' + C.headerFg }, name: 'Arial' };
    titleCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.headerBg } };
    titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
    summary_sheet.getRow(1).height = 36;

    // Generated info
    summary_sheet.mergeCells('A2:C2');
    const infoCell = summary_sheet.getCell('A2');
    const filterDesc = buildFilterDescription(req.query);
    infoCell.value     = `Generated: ${new Date().toLocaleString()} | Filters: ${filterDesc}`;
    infoCell.font      = { size: 9, color: { argb: 'FF888888' }, name: 'Arial' };
    infoCell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111111' } };
    infoCell.alignment = { horizontal: 'center' };
    summary_sheet.getRow(2).height = 18;

    // Spacer
    summary_sheet.getRow(3).height = 8;

    // Stats header
    const statsHeader = summary_sheet.getRow(4);
    statsHeader.values  = ['Metric', 'Value', 'Notes'];
    statsHeader.font    = { bold: true, color: { argb: 'FF' + C.accentFg }, name: 'Arial', size: 10 };
    statsHeader.fill    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.accentBg.replace('#','') } };
    statsHeader.height  = 22;
    statsHeader.alignment = { horizontal: 'center' };

    const statsData = [
      ['Total Transfers',     s.total,                   ''],
      ['✅ Committed',        s.committed,               `${s.total > 0 ? ((s.committed/s.total)*100).toFixed(1) : 0}% success rate`],
      ['⏳ Reserved',         s.reserved,                ''],
      ['📋 Prepared',         s.prepared,                ''],
      ['❌ Failed',           s.failed,                  `${s.total > 0 ? ((s.failed/s.total)*100).toFixed(1) : 0}% failure rate`],
      ['⏰ Timeout',          s.timeout,                 ''],
      ['💰 Total Amount',     parseFloat(s.total_amount || 0).toFixed(2), 'Committed transfers only'],
      ['⚡ Avg Duration',     s.avg_duration ? `${parseFloat(s.avg_duration).toFixed(1)}s` : 'N/A', 'Committed transfers'],
    ];

    statsData.forEach((row, idx) => {
      const r = summary_sheet.getRow(5 + idx);
      r.values = row;
      r.font   = { name: 'Arial', size: 10 };
      r.height = 20;
      if (idx % 2 === 0) {
        r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
        r.font = { name: 'Arial', size: 10, color: { argb: 'FFCCCCCC' } };
      } else {
        r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111111' } };
        r.font = { name: 'Arial', size: 10, color: { argb: 'FF999999' } };
      }
      // value column bold
      r.getCell(2).font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF00FF00' } };
    });

    // Border for stats table
    for (let row = 4; row <= 4 + statsData.length; row++) {
      for (let col = 1; col <= 3; col++) {
        summary_sheet.getRow(row).getCell(col).border = {
          top:    { style: 'thin', color: { argb: 'FF222222' } },
          left:   { style: 'thin', color: { argb: 'FF222222' } },
          bottom: { style: 'thin', color: { argb: 'FF222222' } },
          right:  { style: 'thin', color: { argb: 'FF222222' } },
        };
      }
    }

    const tx_sheet = wb.addWorksheet('Transactions', {
      properties: { tabColor: { argb: 'FF0066CC' } },
    });

    const cols = [
      { header: '#',            key: 'num',           width: 6  },
      { header: 'Transfer ID',  key: 'transfer_id',   width: 38 },
      { header: 'Payer FSP',    key: 'payer_fsp',     width: 14 },
      { header: 'Payee FSP',    key: 'payee_fsp',     width: 14 },
      { header: 'Amount',       key: 'amount',        width: 14 },
      { header: 'Currency',     key: 'currency',      width: 10 },
      { header: 'Status',       key: 'status',        width: 13 },
      { header: 'Created At',   key: 'created_at',    width: 20 },
      { header: 'Completed At', key: 'completed_at',  width: 20 },
      { header: 'Duration (s)', key: 'duration_sec',  width: 13 },
    ];
    tx_sheet.columns = cols;

    // Header row
    const txHeader = tx_sheet.getRow(1);
    txHeader.font      = { bold: true, color: { argb: 'FF' + C.headerFg }, name: 'Arial', size: 10 };
    txHeader.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.headerBg } };
    txHeader.height    = 24;
    txHeader.alignment = { horizontal: 'center', vertical: 'middle' };
    txHeader.values    = cols.map(c => c.header);

    // Freeze header
    tx_sheet.views = [{ state: 'frozen', ySplit: 1 }];

    // Auto filter
    tx_sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to:   { row: 1, column: cols.length },
    };

    // Status color map
    const statusColor = {
      'COMMITTED': C.committed,
      'FAILED':    C.failed,
      'RESERVED':  C.reserved,
      'RECEIVED':  C.prepared,
      'TIMEOUT':   'FFE5E5',
    };

    // Data rows
    transfers.forEach((t, idx) => {
      const row = tx_sheet.addRow([
        idx + 1,
        t.transfer_id,
        t.payer_fsp,
        t.payee_fsp,
        parseFloat(t.amount || 0),
        t.currency,
        t.status,
        t.created_at   ? new Date(t.created_at).toLocaleString()   : '',
        t.completed_at ? new Date(t.completed_at).toLocaleString() : '',
        t.duration_sec != null ? parseFloat(t.duration_sec).toFixed(1) : '',
      ]);

      row.height = 18;
      row.font   = { name: 'Arial', size: 9 };

      // Alternate row color
      const bg = statusColor[t.status] || (idx % 2 === 0 ? 'FFFFFF' : C.altRow);
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + bg } };

      // Amount right-align
      row.getCell(5).alignment  = { horizontal: 'right' };
      row.getCell(5).numFmt     = '#,##0.00';
      row.getCell(10).alignment = { horizontal: 'right' };

      // Status bold
      row.getCell(7).font = { name: 'Arial', size: 9, bold: true };

      // Border
      for (let col = 1; col <= cols.length; col++) {
        row.getCell(col).border = {
          bottom: { style: 'hair', color: { argb: 'FFDDDDDD' } },
          right:  { style: 'hair', color: { argb: 'FFDDDDDD' } },
        };
      }
    });

    // Total row
    const totalRow = tx_sheet.addRow([
      '', 'TOTAL', '', '',
      `=SUM(E2:E${transfers.length + 1})`,
      '', '', '', '', '',
    ]);
    totalRow.font = { bold: true, name: 'Arial', size: 10 };
    totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + C.headerBg } };
    totalRow.getCell(2).font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial' };
    totalRow.getCell(5).font = { bold: true, color: { argb: 'FF00FF00' }, name: 'Arial' };
    totalRow.getCell(5).numFmt = '#,##0.00';

    // ════════════════════════════════════════════════════
    //  SEND RESPONSE
    // ════════════════════════════════════════════════════
    const filename = `r-switch-report-${new Date().toISOString().slice(0,10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: err.message });
  }
};


function buildFilterDescription(query) {
  const parts = [];
  if (query.date_preset === 'today')     parts.push('Today');
  if (query.date_preset === 'yesterday') parts.push('Yesterday');
  if (query.date_preset === 'this_week') parts.push('This Week');
  if (query.from && query.to)            parts.push(`${query.from} to ${query.to}`);
  if (query.dfsp)                        parts.push(`DFSP: ${query.dfsp}`);
  if (query.direction)                   parts.push(`Direction: ${query.direction}`);
  if (query.status && query.status !== 'ALL') parts.push(`Status: ${query.status}`);
  return parts.length ? parts.join(', ') : 'All Transfers';
}
