const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache 5 minutos
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', servicio: 'Tutu Transferencias' });
});

app.get('/api/estimar', async (req, res) => {
  const { patente } = req.query;

  if (!patente) {
    return res.status(400).json({ error: 'Falta el parámetro patente' });
  }

  const patenteNorm = patente.toUpperCase().replace(/[^A-Z0-9]/g, '');

  const formatoViejo = /^[A-Z]{3}\d{3}$/;
  const formatoNuevo = /^[A-Z]{2}\d{3}[A-Z]{2}$/;
  if (!formatoViejo.test(patenteNorm) && !formatoNuevo.test(patenteNorm)) {
    return res.status(400).json({ error: 'Formato inválido. Ejemplos: ABC123 o AB123CD' });
  }

  // Verificar cache
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    console.log('[SCRAPER] Abriendo estimador DNRPA...');
  await page.goto('https://www2.jus.gob.ar/dnrpa-site/#!/estimador', {
  waitUntil: 'networkidle',
  timeout: 45000
});

// Esperar que Angular cargue completamente
await page.waitForTimeout(6000);

// Log de todo el HTML para ver qué hay
const htmlCompleto = await page.evaluate(() => document.body.innerHTML);
console.log('[SCRAPER] HTML:', htmlCompleto.substring(0, 5000));

// Intentar clickear opción Transferencia
try {
  await page.waitForSelector('input, button, a, select', { timeout: 10000 });
  const elementosClickeables = await page.evaluate(() => {
    const els = document.querySelectorAll('button, a, input[type="radio"], input[type="button"], li, div[ng-click], span[ng-click]');
    return Array.from(els).map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim().substring(0, 80),
      id: el.id,
      class: el.className,
      ngClick: el.getAttribute('ng-click'),
      href: el.getAttribute('href'),
      visible: el.offsetParent !== null
    })).filter(e => e.visible && e.text);
  });
  console.log('[SCRAPER] Elementos clickeables:', JSON.stringify(elementosClickeables, null, 2));
} catch(e) {
  console.log('[SCRAPER] Error buscando elementos:', e.message);
}

await page.waitForTimeout(3000); 
    });

    // Esperar que Angular termine de cargar
    await page.waitForTimeout(8000);

    // Log del HTML para debug
    const pageTitle = await page.title();
    console.log('[SCRAPER] Página cargada:', pageTitle);
    
    // Esperar a que Angular renderice los inputs
try {
  await page.waitForSelector('input', { timeout: 15000 });
} catch(e) {
  console.log('[SCRAPER] No aparecieron inputs, continuando igual...');
}
    const inputsInfo = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      return Array.from(inputs).map((inp, idx) => ({
        idx,
        id: inp.id,
        name: inp.name,
        placeholder: inp.placeholder,
        type: inp.type,
        ngModel: inp.getAttribute('ng-model'),
        visible: inp.offsetParent !== null
      }));
    });
    console.log('[SCRAPER] Inputs disponibles:', JSON.stringify(inputsInfo, null, 2));

    // Buscar input de patente/dominio
    let patenteInput = null;
    for (const inp of inputsInfo) {
      if (!inp.visible) continue;
      const buscar = [inp.id, inp.name, inp.placeholder, inp.ngModel].join(' ').toLowerCase();
      if (buscar.includes('dominio') || buscar.includes('patente') || buscar.includes('placa')) {
        if (inp.id) patenteInput = `#${inp.id}`;
        else if (inp.name) patenteInput = `input[name="${inp.name}"]`;
        else if (inp.ngModel) patenteInput = `input[ng-model="${inp.ngModel}"]`;
        console.log('[SCRAPER] Input patente encontrado:', inp);
        break;
      }
    }

    // Fallback: primer input texto visible
    if (!patenteInput) {
      const primerInput = inputsInfo.find(i => i.visible && i.type !== 'hidden');
      if (primerInput) {
        if (primerInput.id) patenteInput = `#${primerInput.id}`;
        else patenteInput = `input:nth-of-type(${primerInput.idx + 1})`;
        console.log('[SCRAPER] Usando primer input visible como fallback:', primerInput);
      }
    }

    if (!patenteInput) {
      throw new Error('No se encontró el campo de patente en el formulario');
    }

    // Limpiar y escribir patente
    await page.click(patenteInput);
    await page.fill(patenteInput, '');
    await page.type(patenteInput, patenteNorm, { delay: 100 });
    console.log(`[SCRAPER] Patente escrita: ${patenteNorm}`);

    await page.keyboard.press('Tab');
    await page.waitForTimeout(1500);

    // Buscar y llenar campo de valor con 1
    const inputsActualizados = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      return Array.from(inputs).map((inp, idx) => ({
        idx,
        id: inp.id,
        name: inp.name,
        placeholder: inp.placeholder,
        type: inp.type,
        ngModel: inp.getAttribute('ng-model'),
        visible: inp.offsetParent !== null,
        value: inp.value
      }));
    });

    let valorInput = null;
    for (const inp of inputsActualizados) {
      if (!inp.visible) continue;
      const buscar = [inp.id, inp.name, inp.placeholder, inp.ngModel].join(' ').toLowerCase();
      if (buscar.includes('valor') || buscar.includes('monto') || buscar.includes('precio') || buscar.includes('importe')) {
        if (inp.id) valorInput = `#${inp.id}`;
        else if (inp.name) valorInput = `input[name="${inp.name}"]`;
        else if (inp.ngModel) valorInput = `input[ng-model="${inp.ngModel}"]`;
        console.log('[SCRAPER] Input valor encontrado:', inp);
        break;
      }
    }

    if (valorInput) {
      await page.click(valorInput);
      await page.fill(valorInput, '1');
      console.log('[SCRAPER] Valor 1 ingresado');
    }

    // Buscar botón de calcular
    const botonesInfo = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn');
      return Array.from(btns).map((btn, idx) => ({
        idx,
        text: btn.textContent?.trim() || btn.value || '',
        id: btn.id,
        class: btn.className,
        visible: btn.offsetParent !== null
      }));
    });
    console.log('[SCRAPER] Botones:', JSON.stringify(botonesInfo));

    let btnClickeado = false;
    for (const btn of botonesInfo) {
      if (!btn.visible) continue;
      const txt = btn.text.toLowerCase();
      if (txt.includes('calcular') || txt.includes('consultar') || txt.includes('estimar') ||
          txt.includes('buscar') || txt.includes('obtener') || txt.includes('cotizar') ||
          txt.includes('aceptar') || txt.includes('enviar')) {
        try {
          if (btn.id) await page.click(`#${btn.id}`);
          else await page.click(`button:has-text("${btn.text}")`);
          console.log(`[SCRAPER] Botón clickeado: "${btn.text}"`);
          btnClickeado = true;
          break;
        } catch (e) {
          console.log(`[SCRAPER] No se pudo clickear "${btn.text}":`, e.message);
        }
      }
    }

    if (!btnClickeado) {
      // Intentar Enter como fallback
      await page.keyboard.press('Enter');
      console.log('[SCRAPER] Enviado con Enter como fallback');
    }

    // Esperar resultados
    await page.waitForTimeout(6000);

    // Extraer texto completo para análisis
    const textoCompleto = await page.evaluate(() => document.body.innerText);
    console.log('[SCRAPER] Texto completo de la página:', textoCompleto.substring(0, 4000));

    // Extraer valores monetarios
    const resultado = await page.evaluate(() => {
      const texto = document.body.innerText;

      // Función para extraer monto argentino ($1.234.567,89 o 1234567,89)
      const extraerMonto = (texto, keywords) => {
        for (const kw of keywords) {
          const regex = new RegExp(kw + '[^\\d$]*\\$?\\s*([\\d.]+,\\d{2})', 'i');
          const match = texto.match(regex);
          if (match) {
            const numStr = match[1].replace(/\./g, '').replace(',', '.');
            const num = parseFloat(numStr);
            if (!isNaN(num) && num > 0) return num;
          }
        }
        return null;
      };

      const costoTramite = extraerMonto(texto, [
        'costo del tr[áa]mite',
        'costo tr[áa]mite',
        'total a abonar',
        'total del tr[áa]mite',
        'arancel'
      ]);

      const valorTabla = extraerMonto(texto, [
        'valor de tabla',
        'valor tabla',
        'valuaci[oó]n',
        'valor fiscal',
        'precio de referencia',
        'valor referencial'
      ]);

      // Extraer TODOS los montos que aparecen para debug
      const todosLosMontos = [];
      const regexMontos = /\$\s*([\d.]+,\d{2})/g;
      let m;
      while ((m = regexMontos.exec(texto)) !== null) {
        todosLosMontos.push(parseFloat(m[1].replace(/\./g, '').replace(',', '.')));
      }

      return { costoTramite, valorTabla, todosLosMontos, texto: texto.substring(0, 4000) };
    });

    console.log('[SCRAPER] costoTramite:', resultado.costoTramite);
    console.log('[SCRAPER] valorTabla:', resultado.valorTabla);
    console.log('[SCRAPER] Todos los montos encontrados:', resultado.todosLosMontos);

    await browser.close();

    if (!resultado.costoTramite && !resultado.valorTabla) {
      return res.status(422).json({
        error: 'No se pudieron extraer los valores. Revisá los logs del servidor.',
        debug: {
          texto: resultado.texto,
          montosEncontrados: resultado.todosLosMontos
        }
      });
    }

    const sellado = resultado.valorTabla ? resultado.valorTabla * 0.01 : 0;
    const respuesta = {
      patente: patenteNorm,
      costoTramite: resultado.costoTramite,
      valorTabla: resultado.valorTabla,
      sellado: Math.round(sellado),
      totalDNRPA: Math.round((resultado.costoTramite || 0) + sellado),
      timestamp: new Date().toISOString()
    };

    cache.set(patenteNorm, { data: respuesta, timestamp: Date.now() });
    console.log('[SCRAPER] Resultado final:', respuesta);
    res.json(respuesta);

  } catch (err) {
    console.error('[SCRAPER] Error fatal:', err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({
      error: 'Error al consultar el estimador DNRPA',
      detalle: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Tutu Transferencias corriendo en puerto ${PORT}`);
});
