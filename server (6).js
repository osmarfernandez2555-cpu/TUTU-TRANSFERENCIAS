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
  const tramite = req.query.tramite || '08';

  if (!patente) return res.status(400).json({ error: 'Falta patente' });

  const formatoViejo = /^[A-Z]{3}\d{3}$/;
  const formatoNuevo = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
  if (!formatoViejo.test(patente) && !formatoNuevo.test(patente)) {
    return res.status(400).json({ error: 'Formato invalido. Ej: ABC123 o AB123CD' });
  }

  const cacheKey = patente + '_' + tramite;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('[CACHE] ' + cacheKey);
    return res.json(cached.data);
  }

  console.log('[SCRAPER] Patente: ' + patente + ' | Tramite: ' + tramite);
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();

    await page.goto('https://www2.jus.gob.ar/dnrpa-site/#!/estimador', {
      waitUntil: 'networkidle',
      timeout: 45000
    });

    // Esperar que Angular cargue el scope con los tipos de tramites
    console.log('[SCRAPER] Esperando que Angular cargue los tramites...');
    await page.waitForFunction(() => {
      const sel = document.getElementById('codigoTramite');
      if (!sel) return false;
      const scope = window.angular && window.angular.element(sel).scope();
      return scope && scope.estimadorCtrl && scope.estimadorCtrl.tiposTramites && scope.estimadorCtrl.tiposTramites.length > 0;
    }, { timeout: 25000 });

    // Ver opciones via Angular scope
    const opciones = await page.evaluate(() => {
      const sel = document.getElementById('codigoTramite');
      const scope = window.angular.element(sel).scope();
      return scope.estimadorCtrl.tiposTramites.map(t => ({
        codigo: t.CodigoTramite,
        nombre: t.NombreTramite
      }));
    });
    console.log('[SCRAPER] Tramites disponibles:', JSON.stringify(opciones));

    // Seleccionar via Angular scope directamente
    const codigoSeleccionado = await page.evaluate((tramiteDeseado, opciones) => {
      const sel = document.getElementById('codigoTramite');
      const scope = window.angular.element(sel).scope();

      // Buscar el codigo correcto
      let codigo = tramiteDeseado;
      const opcion = opciones.find(o =>
        o.codigo === tramiteDeseado ||
        o.nombre.toLowerCase().includes('transferencia')
      );
      if (opcion) codigo = opcion.codigo;

      // Setear en el scope de Angular
      scope.estimadorCtrl.codigoTramite = codigo;
      scope.$apply();

      return codigo;
    }, tramite, opciones);

    console.log('[SCRAPER] Tramite seteado via Angular:', codigoSeleccionado);
    await page.waitForTimeout(2000);

    // Click en Continuar
    await page.click('button:has-text("Continuar")');
    console.log('[SCRAPER] Click Continuar');
    await page.waitForTimeout(5000);

    // Esperar inputs del siguiente paso
    await page.waitForFunction(() => {
      const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"])'));
      return inputs.filter(i => i.offsetParent !== null).length > 0;
    }, { timeout: 15000 });

    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        id: i.id, name: i.name, placeholder: i.placeholder,
        type: i.type, ngModel: i.getAttribute('ng-model'),
        visible: i.offsetParent !== null
      }));
    });
    console.log('[SCRAPER] Inputs:', JSON.stringify(inputs));

    // Buscar campo patente
    let patenteSelector = null;
    for (const inp of inputs) {
      if (!inp.visible) continue;
      const txt = [inp.id, inp.name, inp.placeholder, inp.ngModel].join(' ').toLowerCase();
      if (txt.includes('dominio') || txt.includes('patente') || txt.includes('placa')) {
        patenteSelector = inp.id ? '#' + inp.id :
          inp.name ? 'input[name="' + inp.name + '"]' :
          inp.ngModel ? 'input[ng-model="' + inp.ngModel + '"]' : null;
        break;
      }
    }
    if (!patenteSelector) {
      const v = inputs.filter(i => i.visible && i.type !== 'hidden');
      if (v.length > 0) {
        const i = v[0];
        patenteSelector = i.id ? '#' + i.id : i.name ? 'input[name="' + i.name + '"]' : null;
      }
    }

    if (!patenteSelector) throw new Error('No se encontro campo de patente');
    console.log('[SCRAPER] Campo patente:', patenteSelector);

    await page.fill(patenteSelector, patente);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1500);

    // Buscar campo valor
    const inputs2 = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        id: i.id, name: i.name, placeholder: i.placeholder,
        type: i.type, ngModel: i.getAttribute('ng-model'),
        visible: i.offsetParent !== null, value: i.value
      }));
    });

    let valorSelector = null;
    for (const inp of inputs2) {
      if (!inp.visible) continue;
      const txt = [inp.id, inp.name, inp.placeholder, inp.ngModel].join(' ').toLowerCase();
      if (txt.includes('valor') || txt.includes('monto') || txt.includes('precio') || txt.includes('importe')) {
        valorSelector = inp.id ? '#' + inp.id :
          inp.name ? 'input[name="' + inp.name + '"]' :
          inp.ngModel ? 'input[ng-model="' + inp.ngModel + '"]' : null;
        break;
      }
    }
    if (!valorSelector) {
      const v = inputs2.filter(i => i.visible && i.type !== 'hidden' && !i.value);
      if (v.length > 1) {
        const i = v[1];
        valorSelector = i.id ? '#' + i.id : i.name ? 'input[name="' + i.name + '"]' : null;
      }
    }

    if (valorSelector) {
      await page.fill(valorSelector, '1');
      console.log('[SCRAPER] Valor 1 en:', valorSelector);
    }

    await page.keyboard.press('Enter');
    await page.waitForTimeout(8000);

    // Extraer resultados
    const resultado = await page.evaluate(() => {
      const texto = document.body.innerText;

      const extraerMonto = (texto, keywords) => {
        for (const kw of keywords) {
          const regex = new RegExp(kw + '[^\\d$\\n]{0,30}\\$?\\s*([\\d.]+,[\\d]{2})', 'i');
          const match = texto.match(regex);
          if (match) {
            const num = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
            if (!isNaN(num) && num > 0) return num;
          }
        }
        return null;
      };

      const costoTramite = extraerMonto(texto, ['costo del tr', 'total a abonar', 'arancel']);
      const valorTabla = extraerMonto(texto, ['valor de tabla', 'valor tabla', 'valuaci', 'valor fiscal', 'precio de referencia']);

      const re = /\$\s*([\d.]+,\d{2})/g;
      const todosMontos = [];
      let m;
      while ((m = re.exec(texto)) !== null) {
        todosMontos.push(parseFloat(m[1].replace(/\./g, '').replace(',', '.')));
      }

      return { costoTramite, valorTabla, todosMontos, texto: texto.substring(0, 4000) };
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
      patente,
      tramite,
      costoTramite: resultado.costoTramite,
      valorTabla: resultado.valorTabla,
      sellado: Math.round(sellado),
      totalDNRPA: Math.round((resultado.costoTramite || 0) + sellado),
      timestamp: new Date().toISOString()
    };

    cache.set(cacheKey, { data: respuesta, timestamp: Date.now() });
    console.log('[SCRAPER] OK:', respuesta);
    res.json(respuesta);

  } catch (err) {
    console.error('[SCRAPER] Error:', err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Servidor en puerto ' + PORT));
