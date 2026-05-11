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
    await page.goto('https://www2.jus.gob.ar/dnrpa-site/#!/estimador', { waitUntil: 'networkidle', timeout: 45000 });

    console.log('[SCRAPER] Esperando Angular...');
    await page.waitForFunction(() => {
      const sel = document.getElementById('codigoTramite');
      if (!sel) return false;
      const scope = window.angular && window.angular.element(sel).scope();
      return scope && scope.estimadorCtrl && scope.estimadorCtrl.tiposTramites && scope.estimadorCtrl.tiposTramites.length > 0;
    }, { timeout: 25000 });

    // Seleccionar TRANSFERENCIA via Angular
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
      scope.$apply();
    }, { opciones });

    await page.waitForTimeout(2000);
    await page.click('button:has-text("Continuar")');
    console.log('[SCRAPER] Click Continuar paso 1');
    await page.waitForTimeout(5000);

    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter(i => i.offsetParent !== null).length > 0;
    }, { timeout: 15000 });

    // Setear todos los valores via Angular scope de una sola vez
    const setupOk = await page.evaluate(({ patenteVal }) => {
      const dominio = document.getElementById('dominio');
      if (!dominio) return { ok: false, error: 'no dominio' };
      const scope = window.angular.element(dominio).scope();
      if (!scope || !scope.estimadorCtrl) return { ok: false, error: 'no scope' };
      const ctrl = scope.estimadorCtrl;

      // Setear patente
      ctrl.dominio = patenteVal;

      // Setear valor declarado
      ctrl.valorDeclarado = 1;

      // Setear provincia Córdoba (código X)
      ctrl.codigoProvincia = 'X';

      scope.$apply();

      return {
        ok: true,
        dominio: ctrl.dominio,
        valorDeclarado: ctrl.valorDeclarado,
        codigoProvincia: ctrl.codigoProvincia
      };
    }, { patenteVal: patente });

    console.log('[SCRAPER] Setup Angular:', JSON.stringify(setupOk));
    await page.waitForTimeout(1500);

    // Llamar directamente la función submit del controlador Angular
    const submitOk = await page.evaluate(() => {
      const dominio = document.getElementById('dominio');
      const scope = window.angular.element(dominio).scope();
      const ctrl = scope.estimadorCtrl;

      // Ver qué funciones tiene el controlador
      const funciones = Object.keys(ctrl).filter(k => typeof ctrl[k] === 'function');
      console.log('Funciones del ctrl:', funciones.join(', '));

      // Intentar llamar submit directamente
      if (typeof ctrl.submit === 'function') {
        ctrl.submit();
        scope.$apply();
        return { ok: true, metodo: 'ctrl.submit()' };
      }
      if (typeof ctrl.calcular === 'function') {
        ctrl.calcular();
        scope.$apply();
        return { ok: true, metodo: 'ctrl.calcular()' };
      }
      if (typeof ctrl.consultar === 'function') {
        ctrl.consultar();
        scope.$apply();
        return { ok: true, metodo: 'ctrl.consultar()' };
      }

      // Disparar ng-submit del form
      const form = document.querySelector('form[name="estimadorCtrl.form"]');
      if (form) {
        const event = new Event('submit', { bubbles: true, cancelable: true });
        form.dispatchEvent(event);
        return { ok: true, metodo: 'form submit event', funciones };
      }

      return { ok: false, funciones };
    });

    console.log('[SCRAPER] Submit:', JSON.stringify(submitOk));
    await page.waitForTimeout(8000);

    const resultado = await page.evaluate(() => {
      const texto = document.body.innerText;

      const extraerMonto = (texto, keywords) => {
        for (const kw of keywords) {
          const regex = new RegExp(kw + '[^\\d$\\n]{0,50}\\$?\\s*([\\d.]+,[\\d]{2})', 'i');
          const match = texto.match(regex);
          if (match) {
            const num = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
            if (!isNaN(num) && num > 0) return num;
          }
        }
        return null;
      };

      const costoTramite = extraerMonto(texto, ['costo del tr', 'total a abonar', 'arancel', 'importe', 'costo:']);
      const valorTabla = extraerMonto(texto, ['valor de tabla', 'valor tabla', 'valuaci', 'valor fiscal', 'precio de referencia', 'tabla:']);

      const re = /\$\s*([\d.]+,\d{2})/g;
      const todosMontos = [];
      let m;
      while ((m = re.exec(texto)) !== null) {
        todosMontos.push(parseFloat(m[1].replace(/\./g, '').replace(',', '.')));
      }
      return { costoTramite, valorTabla, todosMontos, texto: texto.substring(0, 5000) };
    });

    console.log('[SCRAPER] costoTramite:', resultado.costoTramite);
    console.log('[SCRAPER] valorTabla:', resultado.valorTabla);
    console.log('[SCRAPER] Montos:', resultado.todosMontos);
    console.log('[SCRAPER] Texto:', resultado.texto);

    await browser.close();

    if (!resultado.costoTramite && !resultado.valorTabla) {
      return res.status(422).json({
        error: 'No se pudieron extraer los valores',
        debug: { texto: resultado.texto, montos: resultado.todosMontos }
      });
    }

    const sellado = resultado.valorTabla ? resultado.valorTabla * 0.01 : 0;
    const respuesta = {
      patente, tramite,
      costoTramite: resultado.costoTramite,
      valorTabla: resultado.valorTabla,
      sellado: Math.round(sellado),
      totalDNRPA: Math.round((resultado.costoTramite || 0) + sellado),
      timestamp: new Date().toISOString()
    };
    cache.set(cacheKey, { data: respuesta, timestamp: Date.now() });
    console.log('[SCRAPER] OK:', JSON.stringify(respuesta));
    res.json(respuesta);

  } catch (err) {
    console.error('[SCRAPER] Error:', err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Servidor en puerto ' + PORT));
