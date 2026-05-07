const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', servicio: 'Tutu Transferencias' });
});

app.get('/api/estimar', async (req, res) => {
  const { patente } = req.query;

  if (!patente) return res.status(400).json({ error: 'Falta el parámetro patente' });

  const patenteNorm = patente.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const formatoViejo = /^[A-Z]{3}\d{3}$/;
  const formatoNuevo = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
  if (!formatoViejo.test(patenteNorm) && !formatoNuevo.test(patenteNorm)) {
    return res.status(400).json({ error: 'Formato inválido. Ejemplos: ABC123 o AB123CD' });
  }

  const cached = cache.get(patenteNorm);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[CACHE] ${patenteNorm}`);
    return res.json(cached.data);
  }

  console.log(`[SCRAPER] Consultando patente: ${patenteNorm}`);
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    console.log('[SCRAPER] Navegando...');
    await page.goto('https://www2.jus.gob.ar/dnrpa-site/#!/estimador', {
      waitUntil: 'networkidle',
      timeout: 45000
    });

    // Esperar que Angular cargue
    await page.waitForTimeout(6000);

    // Log HTML completo para debug
    const html = await page.evaluate(() => document.body.innerHTML);
    console.log('[SCRAPER] HTML:', html.substring(0, 5000));

    // Ver todos los elementos clickeables
    const elementos = await page.evaluate(() => {
      const els = document.querySelectorAll('button, a, input[type="radio"], input[type="button"], li, div[ng-click], span[ng-click], label');
      return Array.from(els).map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim().substring(0, 80),
        id: el.id,
        class: el.className,
        ngClick: el.getAttribute('ng-click'),
        visible: el.offsetParent !== null
      })).filter(e => e.visible && e.text);
    });
    console.log('[SCRAPER] Elementos:', JSON.stringify(elementos, null, 2));

    // Ver todos los inputs
    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        id: i.id, name: i.name, placeholder: i.placeholder,
        type: i.type, ngModel: i.getAttribute('ng-model'),
        visible: i.offsetParent !== null
      }));
    });
    console.log('[SCRAPER] Inputs:', JSON.stringify(inputs, null, 2));

    await browser.close();

    return res.status(422).json({
      error: 'Debug - revisá los logs de Railway',
      debug: { elementos: elementos.slice(0, 20), inputs }
    });

  } catch (err) {
    console.error('[SCRAPER] Error fatal:', err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Tutu Transferencias corriendo en puerto ${PORT}`));
