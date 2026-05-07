const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/estimar', async (req, res) => {
  const patente = (req.query.patente || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!patente) return res.status(400).json({ error: 'Falta patente' });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.goto('https://www2.jus.gob.ar/dnrpa-site/#!/estimador', { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(6000);

    const html = await page.evaluate(() => document.body.innerHTML);
    console.log('[DEBUG HTML]', html.substring(0, 5000));

    const elementos = await page.evaluate(() => {
      const els = document.querySelectorAll('button, a, input, li, div[ng-click], span[ng-click], label');
      return Array.from(els).map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim().substring(0, 60),
        id: el.id,
        ngClick: el.getAttribute('ng-click'),
        type: el.type,
        visible: el.offsetParent !== null
      })).filter(e => e.visible);
    });
    console.log('[DEBUG ELEMENTOS]', JSON.stringify(elementos, null, 2));

    await browser.close();
    res.status(422).json({ debug: elementos.slice(0, 30) });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Servidor en puerto ' + PORT));
