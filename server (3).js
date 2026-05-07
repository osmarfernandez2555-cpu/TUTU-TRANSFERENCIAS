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
  const tramite = req.query.tramite || '08'; // 08 = transferencia por defecto

  if (!patente) return res.status(400).json({ error: 'Falta patente' });

  const formatoViejo = /^[A-Z]{3}\d{3}$/;
  const formatoNuevo = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
  if (!formatoViejo.test(patente) && !formatoNuevo.test(patente)) {
    return res.status(400).json({ error: 'Formato inválido. Ej: ABC123 o AB123CD' });
  }

  const cacheKey = patente + '_' + tramite;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[CACHE] ${cacheKey}`);
    return res.json(cached.data);
  }

  console.log(`[SCRAPER] Patente: ${patente} | Trámite: ${tramite}`);
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
    await page.waitForTimeout(5000);

    // PASO 1: Seleccionar tipo de trámite en el select
    console.log('[SCRAPER] Seleccionando trámite:', tramite);
    await page.waitForSelector('#codigoTramite', { timeout: 15000 });

    // Ver opciones disponibles del select
    const opciones = await page.evaluate(() => {
      const sel = document.getElementById('codigoTramite');
      return Array.from(sel.options).map(o => ({ value: o.value, text: o.text }));
    });
    console.log('[SCRAPER] Opciones del select:', JSON.stringify(opciones));

    // Seleccionar el trámite correcto
    await page.selectOption('#codigoTramite', { value: tramite });
    console.log('[SCRAPER] Trámite seleccionado');
    await page.waitForTimeout(1500);

    // PASO 2: Clickear botón Continuar
    await page.click('button:has-text("Continuar")');
    console.log('[SCRAPER] Click en Continuar');
    await page.waitForTimeout(3000);

    // PASO 3: Ver qué campos aparecen ahora
    const inputs2 = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        id: i.id, name: i.name, placeholder: i.placeholder,
        type: i.type, ngModel: i.getAttribute('ng-model'),
        visible: i.offsetParent !== null
      }));
    });
    console.log('[SCRAPER] Inputs después de Continuar:', JSON.stringify(inputs2, null, 2));

    // Buscar campo dominio/patente
    let patenteSelector = null;
    for (const inp of inputs2) {
      if (!inp.visible) continue;
      const txt = [inp.id, inp.name, inp.placeholder, inp.ngModel].join(' ').toLowerCase();
      if (txt.includes('dominio') || txt.includes('patente') || txt.includes('placa')) {
        if (inp.id) patenteSelector = `#${inp.id}`;
        else if (inp.name) patenteSelector = `input[name="${inp.name}"]`;
        else if (inp.ngModel) patenteSelector = `input[ng-model="${inp.ngModel}"]`;
        break;
      }
    }

    if (!patenteSelector) {
      const visibles = inputs2.filter(i => i.visible && i.type !== 'hidden');
      if (visibles.length > 0) {
        const inp = visibles[0];
        patenteSelector = inp.id ? `#${inp.id}` : inp.name ? `input[name="${inp.name}"]` : 'input:visible';
      }
    }

    console.log('[SCRAPER] Selector patente:', patenteSelector);

    if (!patenteSelector) {
      // Log HTML para debug adicional
      const html2 = await page.evaluate(() => document.body.innerHTML);
      console.log('[SCRAPER] HTML post-continuar:', html2.substring(0, 3000));
      throw new Error('No se encontró el campo de patente después de Continuar');
    }

    // PASO 4: Ingresar patente
    await page.click(patenteSelector);
    await page.fill(patenteSelector, patente);
    console.log('[SCRAPER] Patente ingresada:', patente);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1500);

    // PASO 5: Ingresar valor = 1
    const inputs3 = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        id: i.id, name: i.name, placeholder: i.placeholder,
        type: i.type, ngModel: i.getAttribute('ng-model'),
        visible: i.offsetParent !== null, value: i.value
      }));
    });

    let valorSelector = null;
    for (const inp of inputs3) {
      if (!inp.visible) continue;
      const txt = [inp.id, inp.name, inp.placeholder, inp.ngModel].join(' ').toLowerCase();
      if (txt.includes('valor') || txt.includes('monto') || txt.includes('precio') || txt.includes('importe')) {
        if (inp.id) valorSelector = `#${inp.id}`;
        else if (inp.name) valorSelector = `input[name="${inp.name}"]`;
        else if (inp.ngModel) valorSelector = `input[ng-model="${inp.ngModel}"]`;
        break;
      }
    }

    if (valorSelector) {
      await page.fill(valorSelector, '1');
      console.log('[SCRAPER] Valor 1 ingresado en:', valorSelector);
    } else {
      console.log('[SCRAPER] No se encontró campo de valor, intentando con segundo input visible');
      const visibles = inputs3.filter(i => i.visible && i.type !== 'hidden' && !i.value);
      if (visibles.length > 1) {
        const inp = visibles[1];
        const sel = inp.id ? `#${inp.id}` : `input[name="${inp.name}"]`;
        await page.fill(sel, '1');
        console.log('[SCRAPER] Valor en segundo input:', sel);
      }
    }

    // PASO 6: Submit del formulario
    await page.keyboard.press('Enter');
    console.log('[SCRAPER] Enter para submit');
    await page.waitForTimeout(6000);

    // PASO 7: Extraer resultados
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
        // Buscar todos los montos como fallback
        const montos = [];
        const re = /\$\s*([\d.]+,\d{2})/g;
        let m;
        while ((m = re.exec(texto)) !== null) {
          montos.push(parseFloat(m[1].replace(/\./g, '').replace(',', '.')));
        }
        return montos.length > 0 ? montos[0] : null;
      };

      const costoTramite = extraerMonto(texto, ['costo del tr[áa]mite', 'costo tr[áa]mite', 'total a abonar', 'arancel']);
      const valorTabla = extraerMonto(texto, ['valor de tabla', 'valor tabla', 'valuaci[oó]n', 'valor fiscal', 'precio de referencia']);

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
    console.log('[SCRAPER] Todos los montos:', resultado.todosMontos);
    console.log('[SCRAPER] Texto resultado:', resultado.texto);

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
    console.log('[SCRAPER] Resultado final:', respuesta);
    res.json(respuesta);

  } catch (err) {
    console.error('[SCRAPER] Error fatal:', err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Tutu Transferencias corriendo en puerto ${PORT}`));
