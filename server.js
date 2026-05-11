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
  const patente = (req.query.patente || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tramite = req.query.tramite || 'TRANSFERENCIA';

  if (!patente) return res.status(400).json({ error: 'Falta patente' });
  const formatoViejo = /^[A-Z]{3}\d{3}$/;
  const formatoNuevo = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
  if (!formatoViejo.test(patente) && !formatoNuevo.test(patente)) {
    return res.status(400).json({ error: 'Formato invalido. Ej: ABC123 o AB123CD' });
  }

  const cacheKey = patente + '_' + tramite;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return res.json(cached.data);
  }

  console.log('[SCRAPER] Patente: ' + patente);
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();

    // Interceptar requests para ver qué hace el submit
    const requests = [];
    page.on('request', req => {
      if (!req.url().includes('Content/') && !req.url().includes('.js') && !req.url().includes('.css')) {
        requests.push({ url: req.url(), method: req.method(), postData: req.postData() });
        console.log('[REQUEST]', req.method(), req.url());
      }
    });
    page.on('response', resp => {
      if (!resp.url().includes('Content/') && !resp.url().includes('.js') && !resp.url().includes('.css')) {
        console.log('[RESPONSE]', resp.status(), resp.url());
      }
    });

    await page.goto('https://www2.jus.gob.ar/dnrpa-site/#!/estimador', { waitUntil: 'networkidle', timeout: 45000 });

    await page.waitForFunction(() => {
      const sel = document.getElementById('codigoTramite');
      if (!sel) return false;
      const scope = window.angular && window.angular.element(sel).scope();
      return scope && scope.estimadorCtrl && scope.estimadorCtrl.tiposTramites && scope.estimadorCtrl.tiposTramites.length > 0;
    }, { timeout: 25000 });

    const opciones = await page.evaluate(() => {
      const sel = document.getElementById('codigoTramite');
      const scope = window.angular.element(sel).scope();
      return scope.estimadorCtrl.tiposTramites.map(t => ({ codigo: t.CodigoTramite, nombre: t.NombreTramite }));
    });

    await page.evaluate(({ opciones }) => {
      const sel = document.getElementById('codigoTramite');
      const scope = window.angular.element(sel).scope();
      const opcion = opciones.find(o => o.nombre.toUpperCase().includes('TRANSFERENCIA'));
      scope.estimadorCtrl.codigoTramite = opcion ? opcion.codigo : opciones[0].codigo;
      sel.value = 'string:' + (opcion ? opcion.codigo : opciones[0].codigo);
      sel.dispatchEvent(new Event('change'));
      scope.$apply();
    }, { opciones });

    await page.waitForTimeout(2000);
    await page.click('button:has-text("Continuar")');
    await page.waitForTimeout(5000);

    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter(i => i.offsetParent !== null).length > 0;
    }, { timeout: 15000 });

    await page.fill('#dominio', patente);
    await page.dispatchEvent('#dominio', 'input');
    await page.dispatchEvent('#dominio', 'change');
    await page.dispatchEvent('#dominio', 'blur');
    await page.waitForTimeout(500);

    await page.fill('input[name="valorDeclarado"]', '1');
    await page.dispatchEvent('input[name="valorDeclarado"]', 'input');
    await page.dispatchEvent('input[name="valorDeclarado"]', 'change');
    await page.dispatchEvent('input[name="valorDeclarado"]', 'blur');
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const sel = document.getElementById('codigoProvincia');
      const opt = Array.from(sel.options).find(o => o.text.toUpperCase().includes('CORDOBA'));
      if (!opt) return;
      sel.value = opt.value;
      ['change', 'input', 'blur'].forEach(ev => sel.dispatchEvent(new Event(ev, { bubbles: true })));
      const scope = window.angular.element(sel).scope();
      if (scope && scope.estimadorCtrl) {
        scope.estimadorCtrl.codigoProvincia = 'X';
        scope.$apply();
      }
    });
    await page.waitForTimeout(500);

    // Ver el codigo fuente de la funcion submit
    const submitCode = await page.evaluate(() => {
      const form = document.querySelector('form[name="estimadorCtrl.form"]');
      const scope = window.angular.element(form).scope();
      const ctrl = scope.estimadorCtrl;
      return {
        submitFn: ctrl.submit ? ctrl.submit.toString().substring(0, 500) : 'no existe',
        todasFunciones: Object.keys(ctrl).filter(k => typeof ctrl[k] === 'function')
      };
    });
    console.log('[SCRAPER] Submit code:', JSON.stringify(submitCode));

    // Forzar validez
    await page.evaluate(() => {
      const form = document.querySelector('form[name="estimadorCtrl.form"]');
      const scope = window.angular.element(form).scope();
      const f = scope.estimadorCtrl.form;
      f.$setSubmitted();
      Object.keys(f).forEach(key => {
        if (key.startsWith('$')) return;
        if (f[key] && f[key].$setValidity) f[key].$setValidity('required', true);
      });
      scope.$apply();
    });

    // Ejecutar submit y esperar navegacion
    console.log('[SCRAPER] Ejecutando submit y esperando respuesta...');
    await page.evaluate(() => {
      const form = document.querySelector('form[name="estimadorCtrl.form"]');
      const scope = window.angular.element(form).scope();
      scope.estimadorCtrl.submit();
      scope.$apply();
    });

    // Esperar que llegue una respuesta HTTP del backend DNRPA
    await page.waitForTimeout(15000);

    const textoFinal = await page.evaluate(() => document.body.innerText);
    console.log('[SCRAPER] Texto post-submit:', textoFinal.substring(0, 5000));

    // Ver si hay requests al backend
    console.log('[SCRAPER] Requests capturados:', JSON.stringify(requests.slice(-10)));

    await browser.close();
    return res.status(422).json({ debug: { texto: textoFinal.substring(0, 2000), requests: requests.slice(-10) } });

  } catch (err) {
    console.error('[SCRAPER] Error:', err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Servidor en puerto ' + PORT));
