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
      // Tambien setear el DOM
      sel.value = 'string:' + (opcion ? opcion.codigo : opciones[0].codigo);
      sel.dispatchEvent(new Event('change'));
      scope.$apply();
    }, { opciones });

    await page.waitForTimeout(2000);
    await page.click('button:has-text("Continuar")');
    console.log('[SCRAPER] Click Continuar paso 1');
    await page.waitForTimeout(5000);

    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter(i => i.offsetParent !== null).length > 0;
    }, { timeout: 15000 });

    // PATENTE: usar page.fill que dispara eventos nativos que Angular escucha
    await page.fill('#dominio', patente);
    await page.dispatchEvent('#dominio', 'input');
    await page.dispatchEvent('#dominio', 'change');
    await page.dispatchEvent('#dominio', 'blur');
    console.log('[SCRAPER] Patente ingresada');
    await page.waitForTimeout(800);

    // VALOR: usar page.fill
    await page.fill('input[name="valorDeclarado"]', '1');
    await page.dispatchEvent('input[name="valorDeclarado"]', 'input');
    await page.dispatchEvent('input[name="valorDeclarado"]', 'change');
    await page.dispatchEvent('input[name="valorDeclarado"]', 'blur');
    console.log('[SCRAPER] Valor declarado ingresado');
    await page.waitForTimeout(800);

    // PROVINCIA: setear DOM + eventos + Angular scope
    await page.evaluate(() => {
      const sel = document.getElementById('codigoProvincia');
      // Buscar Córdoba
      const opt = Array.from(sel.options).find(o => o.text.toUpperCase().includes('CORDOBA'));
      if (!opt) return;
      sel.value = opt.value;
      // Disparar todos los eventos que Angular escucha
      ['change', 'input', 'blur'].forEach(ev => sel.dispatchEvent(new Event(ev, { bubbles: true })));
      // También Angular scope
      const scope = window.angular.element(sel).scope();
      if (scope && scope.estimadorCtrl) {
        scope.estimadorCtrl.codigoProvincia = 'X';
        scope.$apply();
      }
    });
    console.log('[SCRAPER] Provincia Cordoba seteada');
    await page.waitForTimeout(1000);

    // Verificar estado del form Angular
    const formState = await page.evaluate(() => {
      const form = document.querySelector('form[name="estimadorCtrl.form"]');
      if (!form) return { error: 'no form' };
      const scope = window.angular.element(form).scope();
      const f = scope.estimadorCtrl.form;
      return {
        valid: f.$valid,
        invalid: f.$invalid,
        errors: JSON.stringify(f.$error),
        dominio: scope.estimadorCtrl.dominio,
        valorDeclarado: scope.estimadorCtrl.valorDeclarado,
        codigoProvincia: scope.estimadorCtrl.codigoProvincia
      };
    });
    console.log('[SCRAPER] Form state:', JSON.stringify(formState));

    // Si el form es inválido, forzar validez via Angular
    if (!formState.valid) {
      await page.evaluate(() => {
        const form = document.querySelector('form[name="estimadorCtrl.form"]');
        const scope = window.angular.element(form).scope();
        const f = scope.estimadorCtrl.form;
        // Marcar todos los campos como touched y pristine
        f.$setSubmitted();
        // Forzar validez de cada campo
        Object.keys(f).forEach(key => {
          if (key.startsWith('$')) return;
          const field = f[key];
          if (field && field.$setValidity) {
            field.$setValidity('required', true);
          }
        });
        scope.$apply();
      });
      await page.waitForTimeout(500);
    }

    // Submit via ctrl.submit()
    await page.evaluate(() => {
      const form = document.querySelector('form[name="estimadorCtrl.form"]');
      const scope = window.angular.element(form).scope();
      scope.estimadorCtrl.submit();
      scope.$apply();
    });
    console.log('[SCRAPER] Submit ejecutado');
    await page.waitForTimeout(10000);

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
