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
  const provincia = req.query.provincia || 'CORDOBA';

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

    const opciones = await page.evaluate(() => {
      const sel = document.getElementById('codigoTramite');
      const scope = window.angular.element(sel).scope();
      return scope.estimadorCtrl.tiposTramites.map(t => ({ codigo: t.CodigoTramite, nombre: t.NombreTramite }));
    });
    console.log('[SCRAPER] Tramites:', JSON.stringify(opciones));

    // Seleccionar TRANSFERENCIA por nombre
    const codigoSeleccionado = await page.evaluate(({ tramiteDeseado, opciones }) => {
      const sel = document.getElementById('codigoTramite');
      const scope = window.angular.element(sel).scope();
      const opcion = opciones.find(o =>
        o.nombre.toUpperCase().includes(tramiteDeseado.toUpperCase()) ||
        o.nombre.toUpperCase().includes('TRANSFERENCIA')
      );
      const codigo = opcion ? opcion.codigo : opciones[0].codigo;
      scope.estimadorCtrl.codigoTramite = codigo;
      scope.$apply();
      return codigo;
    }, { tramiteDeseado: tramite, opciones });

    console.log('[SCRAPER] Tramite seteado:', codigoSeleccionado);
    await page.waitForTimeout(2000);

    await page.click('button:has-text("Continuar")');
    console.log('[SCRAPER] Click Continuar');
    await page.waitForTimeout(5000);

    // Esperar inputs visibles
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll('input:not([type="hidden"])')).filter(i => i.offsetParent !== null).length > 0;
    }, { timeout: 15000 });

    // Ingresar patente en campo dominio
    await page.fill('#dominio', patente);
    console.log('[SCRAPER] Patente ingresada en #dominio');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1500);

    // Ingresar valor declarado = 1
    await page.fill('input[name="valorDeclarado"]', '1');
    console.log('[SCRAPER] Valor declarado = 1');
    await page.waitForTimeout(1000);

    // Seleccionar provincia via Angular scope
    const provinciaOk = await page.evaluate(({ provinciaDeseada }) => {
      // Buscar el select de provincia
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        if (sel.id === 'codigoTramite') continue;
        const scope = window.angular.element(sel).scope();
        if (!scope) continue;
        const ctrl = scope.estimadorCtrl;
        if (!ctrl) continue;

        // Buscar la propiedad que tiene las provincias
        const keys = Object.keys(ctrl);
        for (const key of keys) {
          const val = ctrl[key];
          if (Array.isArray(val) && val.length > 5) {
            const sample = val[0];
            if (sample && (sample.NombreProvincia || sample.nombre || sample.Nombre)) {
              console.log('Provincias encontradas en:', key, JSON.stringify(val.slice(0,3)));
              // Buscar Córdoba
              const prov = val.find(p =>
                (p.NombreProvincia || p.nombre || p.Nombre || '').toUpperCase().includes(provinciaDeseada.toUpperCase())
              );
              if (prov) {
                const codigoProv = prov.CodigoProvincia || prov.codigo || prov.Codigo || prov.id;
                // Setear en el scope
                const ngModel = sel.getAttribute('ng-model');
                if (ngModel) {
                  const parts = ngModel.split('.');
                  if (parts.length === 2) ctrl[parts[1]] = codigoProv;
                  scope.$apply();
                  return { ok: true, provincia: prov, key };
                }
              }
            }
          }
        }
      }
      return { ok: false };
    }, { provinciaDeseada: provincia });

    console.log('[SCRAPER] Provincia resultado:', JSON.stringify(provinciaOk));

    // Si no funcionó Angular, intentar con selectOption directo
    if (!provinciaOk.ok) {
      const selects = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('select')).map(s => ({
          id: s.id, name: s.name, ngModel: s.getAttribute('ng-model'),
          options: Array.from(s.options).slice(0, 5).map(o => ({ v: o.value, t: o.text }))
        }));
      });
      console.log('[SCRAPER] Selects disponibles:', JSON.stringify(selects));

      // Intentar seleccionar Córdoba en cualquier select que no sea codigoTramite
      for (const sel of selects) {
        if (sel.id === 'codigoTramite') continue;
        try {
          const selector = sel.id ? '#' + sel.id : sel.name ? 'select[name="' + sel.name + '"]' : 'select:not(#codigoTramite)';
          await page.selectOption(selector, { label: /c.rdoba/i });
          console.log('[SCRAPER] Provincia seleccionada con selectOption en:', selector);
          break;
        } catch (e) {
          console.log('[SCRAPER] selectOption falló:', e.message);
        }
      }
    }

    await page.waitForTimeout(1000);

    // Submit
    const btnSubmit = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.map(b => ({ text: b.textContent.trim(), visible: b.offsetParent !== null }));
    });
    console.log('[SCRAPER] Botones antes submit:', JSON.stringify(btnSubmit));

    try {
      await page.click('button:has-text("Calcular")');
    } catch(e) {
      try { await page.click('button[type="submit"]'); } catch(e2) {
        await page.keyboard.press('Enter');
      }
    }
    console.log('[SCRAPER] Submit enviado');
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
      const costoTramite = extraerMonto(texto, ['costo del tr', 'total a abonar', 'arancel', 'importe']);
      const valorTabla = extraerMonto(texto, ['valor de tabla', 'valor tabla', 'valuaci', 'valor fiscal', 'precio de referencia', 'tabla']);
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
    console.log('[SCRAPER] OK:', respuesta);
    res.json(respuesta);

  } catch (err) {
    console.error('[SCRAPER] Error:', err.message);
    if (browser) await browser.close().catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Servidor en puerto ' + PORT));
