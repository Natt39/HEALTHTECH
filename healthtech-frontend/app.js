// HealthTech TACO — conectado al backend de Django/DRF (Natt39/HEALTHTECH)
// API_BASE_URL ya viene declarada en config.js (no la repetimos aquí para no romper la página)
const API = `${String(API_BASE_URL).trim().replace(/\/+$/, '')}/api/v1`;
const $ = id => document.getElementById(id);
let accessToken = localStorage.getItem('taco_access') || null;
let refreshToken = localStorage.getItem('taco_refresh') || null;
let idUsuario = localStorage.getItem('taco_id') || null;
let listaMedicamentosActual = [];
let medicamentoEnAlerta = null;
let intervaloAlertas = null;
let sesion = 0;
let mesCalendario = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
const vistaAuth = $('vistaAuth');
const vistaPanel = $('vistaPanel');
const formLogin = $('formLogin');
const formRegistro = $('formRegistro');
const DIAS_SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

// ---------------------------------------------------------------- Conexión con la API (Django)
async function fetchAPI(path, options = {}, _reintentando) {
  const headers = Object.assign({}, options.headers || {});
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`${API}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error('No se pudo conectar con el servidor. Revisa tu conexión a internet.');
  }
  const texto = await res.text();
  let datos = {};
  try { datos = texto ? JSON.parse(texto) : {}; } catch { datos = {}; }

  if (res.status === 401 && !_reintentando && refreshToken) {
    const renovado = await renovarToken();
    if (renovado) return fetchAPI(path, options, true);
  }

  if (datos && typeof datos.ok !== 'undefined') {
    if (!datos.ok) {
      const error = new Error(mensajeDeError(datos.error, 'Ocurrió un error con el servidor.'));
      error.status = datos.status;
      error.details = datos.error?.details;
      throw error;
    }
    return datos;
  }
  if (!res.ok) throw new Error(`Error del servidor (HTTP ${res.status}).`);
  return { ok: true, status: res.status, data: datos };
}

function mensajeDeError(error, predeterminado) {
  if (!error) return predeterminado;
  if (error.details && typeof error.details === 'object') {
    const valores = Object.values(error.details).flat().filter(Boolean);
    if (valores.length) return String(valores[0]);
  }
  return error.message || predeterminado;
}

async function renovarToken() {
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API}/auth/refresh/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh: refreshToken })
    });
    const datos = await res.json().catch(() => ({}));
    if (!res.ok || !datos.ok || !datos.data?.access) return false;
    accessToken = datos.data.access;
    localStorage.setItem('taco_access', accessToken);
    if (datos.data.refresh) {
      refreshToken = datos.data.refresh;
      localStorage.setItem('taco_refresh', refreshToken);
    }
    return true;
  } catch {
    return false;
  }
}

function nombreEnPantalla(nombre) {
  const texto = String(nombre || '').trim() || 'Paciente';
  if ($('nombrePaciente')) $('nombrePaciente').textContent = texto;
  if ($('nombreUsuarioPanel')) $('nombreUsuarioPanel').textContent = texto;
  if ($('nombrePacienteInicio')) $('nombrePacienteInicio').textContent = texto;
}
function contadorMedicamentos() {
  const cantidad = listaMedicamentosActual.length;
  if ($('totalMedicamentos')) $('totalMedicamentos').textContent = String(cantidad);
  if ($('totalMedicamentosResumen')) $('totalMedicamentosResumen').textContent = String(cantidad);
}
function reiniciarResumen() {
  listaMedicamentosActual = [];
  contadorMedicamentos();
  if ($('listaMedicamentos')) $('listaMedicamentos').innerHTML = '<li>Cargando medicamentos...</li>';
  if ($('listaHistorial')) $('listaHistorial').innerHTML = '<li>Cargando historial...</li>';
  if ($('indicadorAdherenciaValor')) $('indicadorAdherenciaValor').textContent = '—';
  pintarReporte([]);
  pintarEstadisticas([]);
  dibujarCalendario();
}
function mostrarPanel() {
  sesion++;
  vistaAuth?.classList.add('hidden');
  vistaPanel?.classList.remove('hidden');
  nombreEnPantalla(localStorage.getItem('taco_nombre'));
  reiniciarResumen();
  cargarHistorial();
  cargarMedicamentos();
  cargarClimaCiudad();
  pedirPermisoNotificaciones();
  iniciarRevisionDeAlertas();
}
function mostrarAuth() {
  sesion++;
  vistaPanel?.classList.add('hidden');
  vistaAuth?.classList.remove('hidden');
  $('alertaPastilla')?.classList.add('hidden');
  medicamentoEnAlerta = null;
  detenerAlarma();
  if (intervaloAlertas) { clearInterval(intervaloAlertas); intervaloAlertas = null; }
  dibujarCalendario();
}
function numeroSeguro(valor) {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  const texto = String(valor).trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(texto)) return null;
  const numero = Number(texto);
  return Number.isFinite(numero) && numero > 0 && numero < 20 ? numero : null;
}
function fechaLegible(valor) {
  if (!valor) return 'No registrado';
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? 'No registrado' : fecha.toLocaleDateString('es-CL');
}
function diasRestantesHasta(valor) {
  if (!valor) return null;
  const objetivo = new Date(valor);
  if (Number.isNaN(objetivo.getTime())) return null;
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const destino = new Date(objetivo.getFullYear(), objetivo.getMonth(), objetivo.getDate());
  return Math.round((destino - hoy) / 86400000);
}
function textoDiasRestantes(valor) {
  const dias = diasRestantesHasta(valor);
  if (dias === null) return '—';
  if (dias < 0) return 'Vencido';
  if (dias === 0) return 'Hoy';
  return `${dias} d.`;
}
function dosisDeHoy(horarioSemanal) {
  const hoy = DIAS_SEMANA[(new Date().getDay() + 6) % 7];
  return (horarioSemanal || {})[hoy] ?? '';
}
function colorAdherenciaMed(m) {
  const corresponde = dosisDeHoy(m.horarioSemanal) && dosisDeHoy(m.horarioSemanal) !== '0';
  if (!corresponde) return 'verde';
  if (m.confirmadaHoy) return 'verde';
  const [h, min] = String(m.horaProgramada || '00:00').split(':').map(Number);
  const ahora = new Date();
  const yaPaso = ahora.getHours() > h || (ahora.getHours() === h && ahora.getMinutes() > (min ?? 0) + 30);
  return yaPaso ? 'rojo' : 'amarillo';
}
function calcularAdherenciaGeneral() {
  if (!listaMedicamentosActual.length) return '—';
  const colores = listaMedicamentosActual.map(colorAdherenciaMed);
  if (colores.includes('rojo')) return 'Baja';
  if (colores.includes('amarillo')) return 'Regular';
  return 'Buena';
}
function proximoControlGeneral() {
  const fechas = listaMedicamentosActual
    .map(m => m.proximoControl)
    .filter(Boolean)
    .sort();
  const hoyISO = fechaLocalISO(new Date());
  return fechas.find(f => f >= hoyISO) || fechas[0] || null;
}
function diasSemanaResumen(horarioSemanal) {
  if (!horarioSemanal) return 'No registrada';
  const dias = [
    ['lunes', 'Lun'], ['martes', 'Mar'], ['miercoles', 'Mié'],
    ['jueves', 'Jue'], ['viernes', 'Vie'], ['sabado', 'Sáb'], ['domingo', 'Dom']
  ];
  return dias.map(([clave, etiqueta]) => `${etiqueta}: ${horarioSemanal[clave] || '—'}`).join(' · ');
}
function pintarReporte(registros) {
  const ultimo = registros[0];
  const valor = ultimo ? numeroSeguro(ultimo.valorINR) : null;
  if ($('ultimoINRPanel')) $('ultimoINRPanel').textContent = valor === null ? '—' : String(ultimo.valorINR);
  if ($('ultimoRangoPanel')) $('ultimoRangoPanel').textContent = ultimo ? `${ultimo.rangoTerapeuticoMin ?? '—'} - ${ultimo.rangoTerapeuticoMax ?? '—'}` : '—';
  if ($('medicoTratante')) $('medicoTratante').textContent = localStorage.getItem('taco_medico') || 'No registrado';
  if ($('proximaConsultaTexto')) $('proximaConsultaTexto').textContent = fechaLegible(proximoControlGeneral());

  if ($('indicadorINRValor')) $('indicadorINRValor').textContent = valor === null ? '—' : String(ultimo.valorINR);
  if ($('indicadorProximoValor')) $('indicadorProximoValor').textContent = textoDiasRestantes(proximoControlGeneral());

  const colorEstado = ultimo ? clasificarLectura(ultimo) : null;
  const ultimoCritico = colorEstado === 'rojo';

  const tarjetaReporte = $('seccionReporte');
  if (tarjetaReporte) {
    tarjetaReporte.style.borderLeft = ultimoCritico ? '5px solid #dc2626' : '5px solid transparent';
  }
  const tarjetaHero = $('tarjetaIndicadorINR');
  if (tarjetaHero) {
    tarjetaHero.classList.remove('inr-verde', 'inr-amarillo', 'inr-rojo');
    if (colorEstado) tarjetaHero.classList.add(`inr-${colorEstado}`);
  }

  const circuloGauge = $('gaugeINRCirculo');
  if (circuloGauge) {
    const CIRCUNFERENCIA = 2 * Math.PI * 52;
    const minRango = ultimo ? numeroSeguro(ultimo.rangoTerapeuticoMin) : null;
    const maxRango = ultimo ? numeroSeguro(ultimo.rangoTerapeuticoMax) : null;
    let porcentaje = 0;
    if (valor !== null && minRango !== null && maxRango !== null && maxRango > minRango) {
      porcentaje = Math.max(0.04, Math.min(1, (valor - minRango) / (maxRango - minRango)));
    } else if (valor !== null) {
      porcentaje = 0.5;
    }
    circuloGauge.style.strokeDasharray = `${(porcentaje * CIRCUNFERENCIA).toFixed(1)} ${CIRCUNFERENCIA.toFixed(1)}`;
  }

  const resumen = $('reporteResumen');
  if (resumen) {
    resumen.textContent = registros.length
      ? `${registros.length} lectura(s) guardada(s). Última: INR ${ultimo.valorINR} (${fechaLegible(ultimo.fechaLectura)}).${ultimoCritico ? ' Fuera del rango terapéutico, contacta a tu médico.' : ''}`
      : 'Aún no tienes lecturas INR guardadas.';
  }

  const svg = $('graficoINR'), vacio = $('graficoINRVacio'), fechas = $('graficoINRFechas');
  const lecturas = registros.filter(r => numeroSeguro(r.valorINR) !== null).slice(0, 6).reverse();

  const miniTendencia = $('miniTendenciaINR');
  if (miniTendencia) {
    if (lecturas.length >= 2) {
      const valoresMini = lecturas.map(r => numeroSeguro(r.valorINR));
      const infMini = Math.min(...valoresMini), supMini = Math.max(...valoresMini);
      const rangoMini = Math.max(supMini - infMini, 0.1);
      const puntosMini = valoresMini.map((v, i) => {
        const x = i * 100 / (valoresMini.length - 1);
        const y = 36 - ((v - infMini) / rangoMini) * 30;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      miniTendencia.setAttribute('points', puntosMini);
    } else {
      miniTendencia.setAttribute('points', '');
    }
  }

  if (!lecturas.length) {
    svg?.classList.add('hidden'); vacio?.classList.remove('hidden');
    if (fechas) fechas.replaceChildren();
    return;
  }
  svg?.classList.remove('hidden'); vacio?.classList.add('hidden');
  const valores = lecturas.map(r => numeroSeguro(r.valorINR));
  const inferior = Math.max(0, Math.min(...valores) - 0.5);
  const superior = Math.max(...valores) + 0.5;
  const rango = Math.max(superior - inferior, 0.1);
  const puntos = valores.map((v, i) => ({ x: lecturas.length === 1 ? 300 : 30 + i * 540 / (lecturas.length - 1), y: 155 - ((v - inferior) / rango) * 125 }));
  const coordenadas = puntos.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const area = `M${puntos[0].x.toFixed(1)},155 L${puntos.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L')} L${puntos[puntos.length - 1].x.toFixed(1)},155 Z`;
  const hayAlgunaCritica = lecturas.some(r => clasificarLectura(r) === 'rojo');
  if ($('graficoINRArea')) $('graficoINRArea').setAttribute('d', area);
  if ($('graficoINRLinea')) {
    $('graficoINRLinea').setAttribute('points', coordenadas);
    $('graficoINRLinea').setAttribute('stroke', hayAlgunaCritica ? '#dc2626' : '#16a34a');
  }
  const grupo = $('graficoINRPuntos');
  if (grupo) {
    grupo.replaceChildren();
    puntos.forEach((p, i) => {
      const esCritico = clasificarLectura(lecturas[i]) === 'rojo';
      const circulo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circulo.setAttribute('cx', p.x.toFixed(1)); circulo.setAttribute('cy', p.y.toFixed(1));
      circulo.setAttribute('r', '5'); circulo.setAttribute('class', 'inr-punto');
      circulo.setAttribute('fill', esCritico ? '#dc2626' : '#16a34a');
      const titulo = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titulo.textContent = `${fechaLegible(lecturas[i].fechaLectura)}: INR ${lecturas[i].valorINR}${esCritico ? ' (fuera de rango)' : ''}`;
      circulo.append(titulo); grupo.append(circulo);
    });
  }
  if (fechas) {
    fechas.replaceChildren();
    lecturas.forEach(r => { const span = document.createElement('span'); span.textContent = fechaLegible(r.fechaLectura); fechas.append(span); });
  }
}
function clasificarLectura(r) {
  const valor = numeroSeguro(r.valorINR);
  const min = numeroSeguro(r.rangoTerapeuticoMin);
  const max = numeroSeguro(r.rangoTerapeuticoMax);
  if (valor === null) return null;
  if (min === null || max === null) return 'verde';
  if (valor >= min && valor <= max) return 'verde';
  const margen = Math.max((max - min) * 0.2, 0.3);
  if (valor >= min - margen && valor <= max + margen) return 'amarillo';
  return 'rojo';
}
function pintarEstadisticas(registros) {
  const vacio = $('estadisticasVacio'), contenido = $('estadisticasContenido');
  const clasificadas = registros.map(clasificarLectura).filter(Boolean);
  if (!vacio || !contenido) return;
  if (!clasificadas.length) { vacio.classList.remove('hidden'); contenido.classList.add('hidden'); return; }
  vacio.classList.add('hidden'); contenido.classList.remove('hidden');
  const total = clasificadas.length;
  const conteo = { verde: 0, amarillo: 0, rojo: 0 };
  clasificadas.forEach(c => conteo[c]++);
  const pct = clave => Math.round((conteo[clave] / total) * 100);
  const pctVerde = pct('verde'), pctAmarillo = pct('amarillo'), pctRojo = 100 - pctVerde - pctAmarillo;
  if ($('donutVerde')) { $('donutVerde').setAttribute('stroke-dasharray', `${pctVerde} 100`); $('donutVerde').setAttribute('stroke-dashoffset', '25'); }
  if ($('donutAmarillo')) { $('donutAmarillo').setAttribute('stroke-dasharray', `${pctAmarillo} 100`); $('donutAmarillo').setAttribute('stroke-dashoffset', String(25 - pctVerde)); }
  if ($('donutRojo')) { $('donutRojo').setAttribute('stroke-dasharray', `${pctRojo} 100`); $('donutRojo').setAttribute('stroke-dashoffset', String(25 - pctVerde - pctAmarillo)); }
  if ($('donutTexto')) $('donutTexto').textContent = `${pctVerde}%`;
  const leyenda = $('leyendaEstadisticas');
  if (leyenda) {
    leyenda.innerHTML = `
      <div><span class="punto-leyenda" style="background:#00CC9F"></span>${pctVerde}% En rango (verde)</div>
      <div><span class="punto-leyenda" style="background:#F2B705"></span>${pctAmarillo}% En el límite (amarillo)</div>
      <div><span class="punto-leyenda" style="background:#DC2626"></span>${pctRojo}% Fuera de rango (rojo)</div>
    `;
  }
}
function fechaLocalISO(fecha) {
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
}
function fechaControlISO(valor) {
  if (!valor) return null;
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fechaLocalISO(fecha);
}
function formatearFechaISO(clave) {
  const [anio, mes, dia] = clave.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'long' }).format(new Date(anio, mes - 1, dia));
}
function controlesPorDia() {
  const controles = new Map();
  for (const med of listaMedicamentosActual) {
    const clave = fechaControlISO(med.proximoControl);
    if (!clave) continue;
    if (!controles.has(clave)) controles.set(clave, []);
    controles.get(clave).push(med.nombre || 'Tratamiento');
  }
  return controles;
}
function dibujarCalendario() {
  const contenedor = $('calendarioPanel');
  if (!contenedor) return;
  const titulo = $('tituloMesCalendario');
  const descripcion = $('detalleProximoControl');
  const anio = mesCalendario.getFullYear();
  const mes = mesCalendario.getMonth();
  if (titulo) titulo.textContent = new Intl.DateTimeFormat('es-CL', { month: 'long', year: 'numeric' }).format(mesCalendario);
  contenedor.replaceChildren();
  const controles = controlesPorDia();
  const fechaHoy = fechaLocalISO(new Date());
  const semana = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  for (const nombre of semana) {
    const elemento = document.createElement('span');
    elemento.className = 'calendario-semana';
    elemento.textContent = nombre;
    contenedor.append(elemento);
  }
  const primerDia = new Date(anio, mes, 1);
  const desplazamiento = (primerDia.getDay() + 6) % 7;
  for (let i = 0; i < desplazamiento; i++) {
    const hueco = document.createElement('span');
    hueco.className = 'calendario-hueco';
    hueco.setAttribute('aria-hidden', 'true');
    contenedor.append(hueco);
  }
  const totalDias = new Date(anio, mes + 1, 0).getDate();
  for (let dia = 1; dia <= totalDias; dia++) {
    const fecha = fechaLocalISO(new Date(anio, mes, dia));
    const celda = document.createElement('span');
    celda.className = 'calendario-dia';
    celda.textContent = String(dia);
    const textoFecha = formatearFechaISO(fecha);
    const nombres = controles.get(fecha);
    if (fecha === fechaHoy) celda.classList.add('calendario-hoy');
    if (nombres) {
      celda.classList.add('calendario-control');
      celda.title = `Control guardado: ${nombres.join(', ')}`;
    }
    celda.setAttribute('aria-label', `${textoFecha}. ${nombres ? `Control guardado: ${nombres.join(', ')}` : 'Sin control guardado'}`);
    contenedor.append(celda);
  }
  if (descripcion) {
    const proximos = [...controles.keys()].filter(fecha => fecha >= fechaHoy).sort();
    const siguiente = proximos[0];
    descripcion.textContent = siguiente
      ? `Próximo control guardado: ${formatearFechaISO(siguiente)} (${controles.get(siguiente).join(', ')}).`
      : 'No hay fechas de próximo control guardadas. Agrégalas al registrar un medicamento.';
  }
}
$('mesAnterior')?.addEventListener('click', () => {
  mesCalendario = new Date(mesCalendario.getFullYear(), mesCalendario.getMonth() - 1, 1);
  dibujarCalendario();
});
$('mesSiguiente')?.addEventListener('click', () => {
  mesCalendario = new Date(mesCalendario.getFullYear(), mesCalendario.getMonth() + 1, 1);
  dibujarCalendario();
});
dibujarCalendario();
if (accessToken && idUsuario) mostrarPanel();
if ($('btnGuardarINR')) $('btnGuardarINR').style.display = 'none';
if ($('mensajeGuardarINR')) $('mensajeGuardarINR').style.display = 'none';

function obtenerUbicacionActual() {
  return new Promise((resolve, reject) => {
    const pluginNativo = window.Capacitor?.Plugins?.Geolocation;
    if (pluginNativo?.getCurrentPosition) {
      pluginNativo.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })
        .then(posicion => resolve({ latitude: posicion.coords.latitude, longitude: posicion.coords.longitude }))
        .catch(reject);
      return;
    }
    if (!('geolocation' in navigator)) { reject(new Error('Geolocalización no disponible')); return; }
    navigator.geolocation.getCurrentPosition(
      posicion => resolve({ latitude: posicion.coords.latitude, longitude: posicion.coords.longitude }),
      reject, { timeout: 8000 }
    );
  });
}

function textoClima(codigo) {
  if ([0].includes(codigo)) return 'Despejado';
  if ([1].includes(codigo)) return 'Mayormente despejado';
  if ([2].includes(codigo)) return 'Parcialmente nublado';
  if ([3].includes(codigo)) return 'Nublado';
  if ([45, 48].includes(codigo)) return 'Con neblina';
  if ([51, 53, 55, 56, 57].includes(codigo)) return 'Llovizna';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(codigo)) return 'Con lluvia';
  if ([71, 73, 75, 77, 85, 86].includes(codigo)) return 'Con nieve';
  if ([95, 96, 99].includes(codigo)) return 'Tormenta eléctrica';
  return 'Clima actual';
}

function iconoClima(codigo) {
  const sol = (cx, r, rayo) => `<circle cx="${cx}" cy="12" r="${r}" fill="url(#gradSol)"/><ellipse cx="${cx - r * 0.3}" cy="${12 - r * 0.35}" rx="${r * 0.4}" ry="${r * 0.25}" fill="#fff" opacity=".35"/>` +
    [0, 45, 90, 135, 180, 225, 270, 315].map(a => {
      const rad = a * Math.PI / 180, x1 = cx + Math.cos(rad) * (r + 2), y1 = 12 + Math.sin(rad) * (r + 2), x2 = cx + Math.cos(rad) * (r + rayo), y2 = 12 + Math.sin(rad) * (r + rayo);
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="url(#gradSol)" stroke-width="2.4" stroke-linecap="round"/>`;
    }).join('');
  const nube = (grad, cy) => `<path d="M6 ${cy + 3.5}a4 4 0 0 1 .4-7.98 5 5 0 0 1 9.6-1.3A4.2 4.2 0 0 1 17 ${cy + 3.5}H6Z" fill="url(#${grad})"/><ellipse cx="9" cy="${cy - 2.5}" rx="3" ry="1.7" fill="#fff" opacity=".4"/>`;

  if ([0, 1].includes(codigo)) {
    return `<svg viewBox="0 0 24 24">${sol(12, 5.4, 3)}</svg>`;
  }
  if (codigo === 2) {
    return `<svg viewBox="0 0 24 24">${sol(7.5, 3.6, 2.2)}${nube('gradNubeClara', 13.5)}</svg>`;
  }
  if (codigo === 3) {
    return `<svg viewBox="0 0 24 24">${nube('gradNubeGris', 12.5)}</svg>`;
  }
  if ([45, 48].includes(codigo)) {
    return `<svg viewBox="0 0 24 24">${nube('gradNubeGris', 10)}<rect x="4" y="16" width="16" height="2" rx="1" fill="url(#gradNubeGris)" opacity=".9"/><rect x="6" y="19.5" width="12" height="2" rx="1" fill="url(#gradNubeGris)" opacity=".7"/></svg>`;
  }
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(codigo)) {
    return `<svg viewBox="0 0 24 24">${nube('gradNubeLluvia', 11.5)}<path d="M8 18c0 1 .8 1.8 1.8 1.8S11.6 19 11.6 18c0-1-1.8-3.2-1.8-3.2S8 17 8 18Z" fill="url(#gradGota)"/><path d="M13.2 19.3c0 .85.68 1.5 1.5 1.5s1.5-.65 1.5-1.5c0-.85-1.5-2.7-1.5-2.7s-1.5 1.85-1.5 2.7Z" fill="url(#gradGota)"/></svg>`;
  }
  if ([71, 73, 75, 77, 85, 86].includes(codigo)) {
    return `<svg viewBox="0 0 24 24">${nube('gradNubeLluvia', 11.5)}<circle cx="9" cy="18.3" r="1.5" fill="url(#gradCopo)"/><circle cx="14" cy="19.6" r="1.5" fill="url(#gradCopo)"/><circle cx="17.5" cy="16.8" r="1.3" fill="url(#gradCopo)"/></svg>`;
  }
  if ([95, 96, 99].includes(codigo)) {
    return `<svg viewBox="0 0 24 24">${nube('gradNubeTormenta', 11.5)}<path d="M12.5 14.5l-3 5h2.6l-1.6 4.5 4.3-6h-2.6l1.8-3.5Z" fill="url(#gradRayo)"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24">${nube('gradNubeClara', 12.5)}</svg>`;
}

async function cargarClimaCiudad() {
  const contenedor = $('climaContenido'), nombreCiudad = $('climaCiudadNombre');
  if (!contenedor) return;
  try {
    const { latitude, longitude } = await obtenerUbicacionActual();
    try {
      const [resClima, resCiudad] = await Promise.all([
        fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min&timezone=auto`),
        fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${latitude}&longitude=${longitude}&localityLanguage=es`)
      ]);
      const datosClima = await resClima.json();
      const datosCiudad = await resCiudad.json();
      const actual = datosClima.current_weather;
      if (nombreCiudad) nombreCiudad.textContent = datosCiudad.city || datosCiudad.locality || 'Tu ubicación';

      const diario = datosClima.daily;
      let filaPronostico = '';
      if (diario?.time?.length) {
        filaPronostico = diario.time.slice(0, 6).map((fecha, i) => {
          const esHoy = i === 0;
          const etiqueta = esHoy ? 'Hoy' : new Date(fecha + 'T00:00:00').toLocaleDateString('es-CL', { weekday: 'short' }).replace('.', '');
          return `<div class="clima-dia"><span>${etiqueta}</span>${iconoClima(diario.weathercode[i])}<strong>${Math.round(diario.temperature_2m_max[i])}°</strong><small>${Math.round(diario.temperature_2m_min[i])}°</small></div>`;
        }).join('');
      }

      contenedor.innerHTML = `
        <div class="clima-actual">
          <div class="clima-icono-grande">${iconoClima(actual?.weathercode ?? 0)}</div>
          <div><p class="clima-temp-grande">${actual?.temperature ?? '—'}°</p><p class="clima-sub">${textoClima(actual?.weathercode ?? 0)}</p></div>
        </div>
        ${filaPronostico ? `<div class="clima-pronostico">${filaPronostico}</div>` : ''}`;
    } catch (error) {
      console.error('Error obteniendo clima:', error);
      contenedor.innerHTML = '<p class="reporte-resumen">No se pudo cargar el clima.</p>';
    }
  } catch (error) {
    contenedor.innerHTML = '<p class="reporte-resumen">Activa la ubicación del celular para ver el clima.</p>';
  }
}

async function compartirUbicacion(automatico) {
  const mensaje = $('mensajeUbicacion');
  if (mensaje) mensaje.textContent = 'Obteniendo tu ubicación...';
  let latitude, longitude;
  try {
    ({ latitude, longitude } = await obtenerUbicacionActual());
  } catch (error) {
    if (mensaje) mensaje.textContent = 'Activa la ubicación del celular para poder compartirla.';
    return;
  }
  const link = `https://maps.google.com/?q=${latitude},${longitude}`;
  const nombre = localStorage.getItem('taco_nombre') || 'Paciente';
  const texto = automatico
    ? `Alerta de HealthTech TACO: ${nombre} no ha confirmado su medicamento. Esta es su ubicación: ${link}`
    : `Mi ubicación en este momento: ${link}`;
  try {
    const pluginNativo = window.Capacitor?.Plugins?.Share;
    if (pluginNativo?.share) {
      await pluginNativo.share({ title: 'Mi ubicación - HealthTech TACO', text: texto });
      if (mensaje) mensaje.textContent = 'Listo, elige con quién compartirla.';
    } else if (navigator.share) {
      await navigator.share({ title: 'Mi ubicación - HealthTech TACO', text: texto });
      if (mensaje) mensaje.textContent = 'Listo, elige con quién compartirla.';
    } else {
      await navigator.clipboard.writeText(texto);
      if (mensaje) mensaje.textContent = 'Copiado. Pégalo en WhatsApp o mensajes para enviarlo.';
    }
  } catch (error) {
    if (mensaje) mensaje.textContent = 'No se pudo abrir para compartir.';
  }
}
$('btnCompartirUbicacion')?.addEventListener('click', () => compartirUbicacion(false));
$('btnProbarAlarma')?.addEventListener('click', () => {
  mostrarAlertaPastilla({ nombre: 'Medicamento de prueba', dosisHoy: '1 comprimido' });
});

formLogin?.addEventListener('submit', async e => {
  e.preventDefault();
  const mensaje = $('mensajeAuth');
  if (mensaje) mensaje.textContent = '';
  try {
    const datos = await fetchAPI('/auth/login/', {
      method: 'POST',
      body: JSON.stringify({ email: $('loginEmail').value.trim(), password: $('loginPassword').value })
    });
    const info = datos.data || {};
    if (!info.access || !info.usuario?.id) {
      if (mensaje) mensaje.textContent = 'El servidor no devolvió los datos esperados.';
      return;
    }
    accessToken = info.access; refreshToken = info.refresh; idUsuario = info.usuario.id;
    localStorage.setItem('taco_access', accessToken);
    localStorage.setItem('taco_refresh', refreshToken || '');
    localStorage.setItem('taco_id', String(idUsuario));
    localStorage.setItem('taco_nombre', info.usuario.nombre ?? 'Paciente');
    mostrarPanel();
  } catch (error) {
    console.error('Error al iniciar sesión:', error);
    if (mensaje) mensaje.textContent = error.message || 'No se puede conectar con el servidor. Revisa que esté encendido.';
  }
});
formRegistro?.addEventListener('submit', async e => {
  e.preventDefault();
  const mensaje = $('mensajeRegistro');
  if (mensaje) mensaje.textContent = '';
  try {
    await fetchAPI('/auth/registro/', {
      method: 'POST',
      body: JSON.stringify({
        nombre: $('regNombre').value.trim(),
        email: $('regEmail').value.trim(),
        password: $('regPassword').value
      })
    });
    formRegistro.reset(); $('tabLogin')?.click();
    setTimeout(() => { if ($('mensajeAuth')) $('mensajeAuth').textContent = 'Cuenta creada. Ahora inicia sesión.'; }, 850);
  } catch (error) {
    console.error('Error en registro:', error);
    if (mensaje) mensaje.textContent = error.message || 'No se puede conectar con el servidor. Revisa que esté encendido.';
  }
});
$('btnSalir')?.addEventListener('click', async () => {
  try {
    if (refreshToken) await fetchAPI('/auth/logout/', { method: 'POST', body: JSON.stringify({ refresh: refreshToken }) });
  } catch { /* no bloquea el cierre de sesión local */ }
  localStorage.removeItem('taco_access'); localStorage.removeItem('taco_refresh');
  localStorage.removeItem('taco_id'); localStorage.removeItem('taco_nombre');
  accessToken = null; refreshToken = null; idUsuario = null; listaMedicamentosActual = [];
  contadorMedicamentos(); nombreEnPantalla('Paciente'); pintarReporte([]); mostrarAuth();
});

// ---------------------------------------------------------------- Escáner de recetas (IA de Gemini vía Django)
function crearPopupReceta() {
  if ($('popupReceta')) return $('popupReceta');
  const overlay = document.createElement('div');
  overlay.id = 'popupReceta';
  overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;z-index:9999;padding:16px;overflow-y:auto;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:24px;max-width:460px;width:100%;max-height:85vh;overflow-y:auto;color:#111;">
      <h3 style="margin-top:0">Revisa los datos antes de guardar</h3>
      <div id="popupRecetaContenido" style="font-size:14px;line-height:1.6"></div>
      <p style="font-size:12px;color:#555;margin-top:12px">Compara estos datos con la hoja original antes de aceptar. La hora de toma y el gramaje no los lee la IA: compruébalos y complétalos tú.</p>
      <div style="display:flex;gap:10px;margin-top:16px">
        <button id="popupRecetaCancelar" type="button" style="flex:1;padding:10px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:14px">Cancelar</button>
        <button id="popupRecetaAceptar" type="button" style="flex:1;padding:10px;border-radius:8px;border:none;background:#16a34a;color:#fff;cursor:pointer;font-size:14px">Aceptar y guardar</button>
      </div>
    </div>
  `;
  document.body.append(overlay);
  return overlay;
}
function diasSemanaTexto(dosisDiaria) {
  const dias = [
    ['lunes', 'Lunes'], ['martes', 'Martes'], ['miercoles', 'Miércoles'],
    ['jueves', 'Jueves'], ['viernes', 'Viernes'], ['sabado', 'Sábado'], ['domingo', 'Domingo']
  ];
  if (!dosisDiaria) return '<li>No se detectó un calendario de dosis.</li>';
  return dias.map(([clave, etiqueta]) => `<li>${etiqueta}: ${seguroHTML(dosisDiaria[clave] ?? '—')}</li>`).join('');
}
function parsearRangoTerapeutico(texto) {
  if (!texto) return { min: null, max: null };
  const numeros = String(texto).replace(',', '.').match(/\d+(?:\.\d+)?/g);
  if (!numeros || numeros.length < 2) return { min: null, max: null };
  return { min: Number(numeros[0]), max: Number(numeros[1]) };
}
function seguroHTML(valor) {
  return String(valor).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function mostrarPopupReceta(datosExtraidos) {
  return new Promise(resolve => {
    const overlay = crearPopupReceta();
    const contenido = $('popupRecetaContenido');
    const { min, max } = parsearRangoTerapeutico(datosExtraidos.rango_terapeutico);
    const inr = datosExtraidos.inr_actual ? Number(String(datosExtraidos.inr_actual).replace(',', '.')) : null;
    const medicamentos = Array.isArray(datosExtraidos.medicamentos) ? datosExtraidos.medicamentos : [];

    contenido.innerHTML = `
      <p><strong>INR:</strong> ${seguroHTML(datosExtraidos.inr_actual ?? 'No legible')}</p>
      <p><strong>Rango terapéutico:</strong> ${seguroHTML(datosExtraidos.rango_terapeutico ?? '—')}</p>
      <p><strong>Médico:</strong> ${seguroHTML(datosExtraidos.medico ?? 'No indicado')}</p>
      <p><strong>Próximo control:</strong> ${seguroHTML(datosExtraidos.fecha_control ?? 'No indicado')}</p>
      ${medicamentos.map((med, i) => `
        <div style="border-top:1px solid #eee;margin-top:10px;padding-top:10px">
          <p><strong>Medicamento ${medicamentos.length > 1 ? i + 1 : ''}:</strong> ${seguroHTML(med.nombre ?? 'No indicado')}</p>
          <label style="display:block;font-size:13px;margin-top:6px">Hora de toma
            <input type="time" id="recetaHora-${i}" value="08:00" style="display:block;width:100%;padding:8px;border-radius:8px;border:1px solid #ccc;margin-top:3px">
          </label>
          <label style="display:block;font-size:13px;margin-top:8px">Unidad / gramaje (ej: Comprimido de 4mg)
            <input type="text" id="recetaUnidad-${i}" placeholder="Comprimido de 4mg" style="display:block;width:100%;padding:8px;border-radius:8px;border:1px solid #ccc;margin-top:3px">
          </label>
          <p style="margin-top:8px"><strong>Dosis por día detectadas:</strong></p>
          <ul style="margin:4px 0 0 18px;padding:0">${diasSemanaTexto(med.dosis_diaria)}</ul>
        </div>
      `).join('') || '<p>No se detectó ningún medicamento en la hoja.</p>'}
    `;
    overlay.style.display = 'flex';
    const limpiar = () => { overlay.style.display = 'none'; };
    $('popupRecetaCancelar').onclick = () => { limpiar(); resolve(null); };
    $('popupRecetaAceptar').onclick = () => {
      const medicamentosConfirmados = medicamentos.map((med, i) => ({
        nombre: med.nombre || 'Medicamento',
        unidadPastilla: $(`recetaUnidad-${i}`)?.value.trim() || 'No indicada',
        horaProgramada: $(`recetaHora-${i}`)?.value || '08:00',
        horarioSemanal: DIAS_SEMANA.reduce((acc, dia) => { acc[dia] = (med.dosis_diaria?.[dia]) || ''; return acc; }, {}),
        proximoControl: datosExtraidos.fecha_control || null
      }));
      limpiar();
      resolve({ inr, min, max, medico: datosExtraidos.medico || null, medicamentos: medicamentosConfirmados });
    };
  });
}

$('formReceta')?.addEventListener('submit', async e => {
  e.preventDefault();
  const archivo = $('inputImagen')?.files?.[0];
  const mensaje = $('mensajeReceta'), resultado = $('resultadoAlerta');
  const boton = $('formReceta')?.querySelector('button[type="submit"]');
  if (!archivo) { if (mensaje) mensaje.textContent = 'Selecciona una imagen primero.'; return; }
  if (!accessToken) { if (mensaje) mensaje.textContent = 'Inicia sesión para analizar la receta.'; return; }
  const textoBoton = boton?.textContent;
  if (boton) { boton.disabled = true; boton.textContent = 'Analizando...'; }
  if (mensaje) mensaje.textContent = 'Analizando imagen con IA...';
  resultado?.classList.add('hidden');
  const formData = new FormData(); formData.append('imagen', archivo);
  try {
    const datos = await fetchAPI('/recetas/analizar/', { method: 'POST', body: formData });
    const datosExtraidos = datos.data || {};

    const confirmado = await mostrarPopupReceta(datosExtraidos);
    if (!confirmado) {
      if (mensaje) mensaje.textContent = 'Escaneo cancelado. No se guardó ningún dato.';
      if ($('inputImagen')) $('inputImagen').value = '';
      return;
    }

    if (mensaje) mensaje.textContent = 'Guardando...';

    if (confirmado.medico) localStorage.setItem('taco_medico', confirmado.medico);

    let registroGuardado = null;
    if (confirmado.inr !== null && confirmado.min !== null && confirmado.max !== null) {
      const resRegistro = await fetchAPI('/registros-inr/', {
        method: 'POST',
        body: JSON.stringify({ valorINR: confirmado.inr, rangoTerapeuticoMin: confirmado.min, rangoTerapeuticoMax: confirmado.max })
      });
      registroGuardado = resRegistro.data;
    }

    for (const med of confirmado.medicamentos) {
      await fetchAPI('/medicamentos/', { method: 'POST', body: JSON.stringify(med) });
    }

    if (resultado) {
      const estado = resultado.querySelector('.resultado-estado'), detalle = resultado.querySelector('.resultado-detalle');
      if (estado) estado.textContent = registroGuardado ? 'Lectura de INR guardada' : 'Medicamento(s) guardado(s)';
      if (detalle) detalle.textContent = registroGuardado
        ? `INR: ${registroGuardado.valorINR} | Rango: ${registroGuardado.rangoTerapeuticoMin} - ${registroGuardado.rangoTerapeuticoMax}`
        : `Se guardaron ${confirmado.medicamentos.length} medicamento(s).`;
      resultado.classList.remove('hidden');
    }

    if (mensaje) mensaje.textContent = 'Listo. Revisa abajo en "Mis medicamentos" y confirma el tratamiento.';
    if ($('inputImagen')) $('inputImagen').value = '';
    await cargarHistorial();
    await cargarMedicamentos();
    $('herramientaMedicamentos')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error('Error analizando receta:', error);
    if (mensaje) mensaje.textContent = error.message || 'No se pudo conectar con el servidor. Revisa que esté encendido.';
  } finally {
    if (boton) { boton.disabled = false; boton.textContent = textoBoton; }
  }
});

$('formMedicamento')?.addEventListener('submit', async e => {
  e.preventDefault(); if (!accessToken) return;
  const form = $('formMedicamento');
  const fechaAConfirmar = fechaControlISO($('medProximoControl')?.value);
  const payload = {
    nombre: $('medNombre')?.value.trim() || '',
    unidadPastilla: $('medUnidad')?.value.trim() || '',
    horaProgramada: $('medHora')?.value || '17:00',
    horarioSemanal: {
      lunes: $('dia-lunes')?.value || '1',
      martes: $('dia-martes')?.value || '1',
      miercoles: $('dia-miercoles')?.value || '1',
      jueves: $('dia-jueves')?.value || '1',
      viernes: $('dia-viernes')?.value || '1',
      sabado: $('dia-sabado')?.value || '1',
      domingo: $('dia-domingo')?.value || '1'
    },
    proximoControl: fechaAConfirmar
  };
  const textoConfirmacion = `Verifica con la receta original antes de guardar:\nMedicamento: ${payload.nombre}\nFecha del próximo control: ${fechaAConfirmar ? formatearFechaISO(fechaAConfirmar) : 'sin fecha'}\n\n¿Guardar tratamiento?`;
  if (!window.confirm(textoConfirmacion)) return;
  try {
    await fetchAPI('/medicamentos/', { method: 'POST', body: JSON.stringify(payload) });
    form.reset(); if ($('medHora')) $('medHora').value = '17:00';
    await cargarMedicamentos(); alert('Tratamiento guardado.');
  } catch (error) {
    console.error('Error al guardar:', error);
    alert(error.message || 'No se pudo conectar con el servidor.');
  }
});

async function cargarMedicamentos() {
  const lista = $('listaMedicamentos'); if (!lista || !accessToken) return;
  const sesionAlSolicitar = sesion, tokenAlSolicitar = accessToken;
  lista.innerHTML = '<li>Cargando medicamentos...</li>';
  try {
    const datos = await fetchAPI('/medicamentos/?page_size=100&ordering=nombre');
    if (sesionAlSolicitar !== sesion || tokenAlSolicitar !== accessToken) return;
    listaMedicamentosActual = Array.isArray(datos.data?.results) ? datos.data.results : [];
    contadorMedicamentos();
    dibujarCalendario();
    if ($('indicadorAdherenciaValor')) $('indicadorAdherenciaValor').textContent = calcularAdherenciaGeneral();
    if ($('indicadorProximoValor')) $('indicadorProximoValor').textContent = textoDiasRestantes(proximoControlGeneral());
    if ($('proximaConsultaTexto')) $('proximaConsultaTexto').textContent = fechaLegible(proximoControlGeneral());
    if (!listaMedicamentosActual.length) { lista.innerHTML = '<li>No tienes medicamentos registrados.</li>'; return; }
    lista.innerHTML = listaMedicamentosActual.map(m => {
      const colorSemaforo = colorAdherenciaMed(m);
      const semaforo = `<span class="punto-semaforo punto-${colorSemaforo}" aria-hidden="true"></span>`;
      const dosisHoy = dosisDeHoy(m.horarioSemanal);
      const corresponde = dosisHoy && dosisHoy !== '0';
      let accion;
      if (m.confirmadaHoy) accion = '<p class="muted">Ya confirmaste la toma de hoy.</p>';
      else if (corresponde) accion = `<button type="button" class="btn-primary" data-confirmar-toma data-id="${m.id}" style="margin-top:8px">Confirmar toma de hoy</button>`;
      else accion = '<p class="muted">Hoy no corresponde tomar esta pastilla.</p>';
      return `<li><article class="medicamento-item">
        <h3>${semaforo} ${seguroHTML(m.nombre || 'Medicamento')}</h3>
        <p>Unidad: ${seguroHTML(m.unidadPastilla || 'No indicada')}</p>
        <p>Hora de toma: ${seguroHTML(String(m.horaProgramada || '').slice(0, 5) || 'No indicada')}</p>
        <p>Dosis de hoy: ${seguroHTML(dosisHoy || '—')}</p>
        <p>Dosis por día: ${seguroHTML(diasSemanaResumen(m.horarioSemanal))}</p>
        <p>Próximo control: ${seguroHTML(fechaLegible(m.proximoControl))}</p>
        ${accion}
      </article></li>`;
    }).join('');
  } catch (error) {
    if (sesionAlSolicitar !== sesion) return;
    console.error('Error cargando medicamentos:', error);
    lista.innerHTML = `<li>${seguroHTML(error.message || 'Error de conexión al cargar medicamentos.')}</li>`;
  }
}
$('listaMedicamentos')?.addEventListener('click', async e => {
  const boton = e.target.closest('[data-confirmar-toma]');
  if (!boton) return;
  const idMedicamento = boton.dataset.id;
  boton.disabled = true;
  try {
    await fetchAPI(`/medicamentos/${idMedicamento}/confirmar/`, { method: 'POST' });
    alert('Toma confirmada correctamente.');
    await cargarMedicamentos();
  } catch (error) {
    console.error('Error confirmando toma:', error);
    alert(error.message || 'No se pudo conectar con el servidor.');
  } finally {
    boton.disabled = false;
  }
});

async function cargarHistorial() {
  const lista = $('listaHistorial'); if (!lista || !accessToken || !idUsuario) return;
  const sesionAlSolicitar = sesion, tokenAlSolicitar = accessToken;
  lista.innerHTML = '<li>Cargando historial...</li>';
  try {
    const datos = await fetchAPI('/registros-inr/?page_size=100');
    if (sesionAlSolicitar !== sesion || tokenAlSolicitar !== accessToken) return;
    const registros = Array.isArray(datos.data?.results) ? datos.data.results : [];
    pintarReporte(registros);
    pintarEstadisticas(registros);
    if (!registros.length) { lista.innerHTML = '<li>No hay registros INR guardados.</li>'; return; }
    lista.innerHTML = registros.map(r => `<li><article class="historial-item"><p><strong>Fecha:</strong> ${seguroHTML(fechaLegible(r.fechaLectura))}</p><p><strong>INR:</strong> ${seguroHTML(r.valorINR ?? 'N/A')}</p><p><strong>Rango:</strong> ${seguroHTML(r.rangoTerapeuticoMin ?? 'N/A')} - ${seguroHTML(r.rangoTerapeuticoMax ?? 'N/A')}</p><p class="muted">${clasificarLectura(r) === 'rojo' ? 'Fuera del rango terapéutico' : 'Dentro del rango normal'}</p></article></li>`).join('');
  } catch (error) {
    if (sesionAlSolicitar !== sesion) return;
    console.error('Error cargando historial:', error);
    lista.innerHTML = `<li>${seguroHTML(error.message || 'Error de conexión al cargar historial.')}</li>`;
    if ($('reporteResumen')) $('reporteResumen').textContent = 'No se pudo cargar el reporte INR.';
  }
}
$('btnActualizarHistorial')?.addEventListener('click', cargarHistorial);

$('btnGenerarQR')?.addEventListener('click', () => {
  alert('La identificación QR de emergencia todavía no está disponible en el sistema de tu compañera. Vamos a verlo con ella para agregarla más adelante.');
});

function pedirPermisoNotificaciones() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
function iniciarRevisionDeAlertas() {
  if (intervaloAlertas) clearInterval(intervaloAlertas);
  revisarHoraDePastillas(); intervaloAlertas = setInterval(revisarHoraDePastillas, 30000);
}
function revisarHoraDePastillas() {
  const overlay = $('alertaPastilla'); if (!overlay || !overlay.classList.contains('hidden')) return;
  const ahora = new Date();
  const hora = `${String(ahora.getHours()).padStart(2, '0')}:${String(ahora.getMinutes()).padStart(2, '0')}`;
  const med = listaMedicamentosActual.find(item => {
    if (item.confirmadaHoy) return false;
    const dosisHoy = dosisDeHoy(item.horarioSemanal);
    if (!dosisHoy || dosisHoy === '0') return false;
    return String(item.horaProgramada || '').slice(0, 5) === hora;
  });
  if (med) mostrarAlertaPastilla(med);
}
let repeticionesAlarma = 0;
let temporizadorAlarma = null;
function vibrarFuerte() {
  if ('vibrate' in navigator) navigator.vibrate([600, 300, 600, 300, 600, 300, 600]);
}

let audioCtxAlarma = null;
function obtenerAudioCtxAlarma() {
  if (!audioCtxAlarma) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    audioCtxAlarma = new Ctx();
  }
  return audioCtxAlarma;
}
['click', 'touchstart'].forEach(evento => {
  document.addEventListener(evento, () => {
    const ctx = obtenerAudioCtxAlarma();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }, { once: true });
});

function sonarAlarmaFuerte() {
  try {
    const ctx = obtenerAudioCtxAlarma();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const ahora = ctx.currentTime;
    const pitidos = 4;
    for (let i = 0; i < pitidos; i++) {
      const inicio = ahora + i * 0.5;
      const osc = ctx.createOscillator();
      const ganancia = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      ganancia.gain.setValueAtTime(0.0001, inicio);
      ganancia.gain.exponentialRampToValueAtTime(1, inicio + 0.03);
      ganancia.gain.exponentialRampToValueAtTime(0.0001, inicio + 0.4);
      osc.connect(ganancia);
      ganancia.connect(ctx.destination);
      osc.start(inicio);
      osc.stop(inicio + 0.42);
    }
  } catch (error) { console.error('Error con el sonido de alarma:', error); }
}

function hablarAlarma(nombreMedicamento) {
  const texto = `Es hora de tomar tu medicina. ${nombreMedicamento || ''}. Es hora de tomar tu medicina.`;
  const pluginNativo = window.Capacitor?.Plugins?.TextToSpeech;
  if (pluginNativo?.speak) {
    pluginNativo.speak({ text: texto, lang: 'es-CL', rate: 0.9, pitch: 1, volume: 1, category: 'ambient' }).catch(error => {
      console.error('Error con la voz nativa de alarma:', error);
    });
    return;
  }
  if (!('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const frase = new SpeechSynthesisUtterance(texto);
    frase.lang = 'es-CL';
    frase.rate = 0.95;
    frase.volume = 1;
    window.speechSynthesis.speak(frase);
  } catch (error) { console.error('Error con la voz de alarma:', error); }
}
function dispararAlarmaCompleta(med) {
  vibrarFuerte();
  sonarAlarmaFuerte();
  hablarAlarma(med.nombre);
}
function mostrarAlertaPastilla(med) {
  medicamentoEnAlerta = med;
  repeticionesAlarma = 0;
  if ($('alertaNombreMed')) $('alertaNombreMed').textContent = `Es hora de: ${med.nombre || 'tu medicamento'}`;
  if ($('alertaDosisMed')) $('alertaDosisMed').textContent = `Dosis de hoy: ${med.dosisHoy ?? dosisDeHoy(med.horarioSemanal) ?? '—'}`;
  if ($('mensajeAlerta')) $('mensajeAlerta').textContent = '';
  $('alertaPastilla')?.classList.remove('hidden');
  if ('Notification' in window && Notification.permission === 'granted') new Notification('HealthTech TACO', { body: `Es hora de tomar ${med.nombre || 'tu medicamento'}` });
  dispararAlarmaCompleta(med);
  if (temporizadorAlarma) clearInterval(temporizadorAlarma);
  temporizadorAlarma = setInterval(() => {
    if ($('alertaPastilla')?.classList.contains('hidden')) { clearInterval(temporizadorAlarma); temporizadorAlarma = null; return; }
    repeticionesAlarma++;
    if (repeticionesAlarma >= 3) { clearInterval(temporizadorAlarma); temporizadorAlarma = null; compartirUbicacion(true); return; }
    dispararAlarmaCompleta(med);
  }, 20000);
}
function detenerAlarma() {
  if (temporizadorAlarma) { clearInterval(temporizadorAlarma); temporizadorAlarma = null; }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if ('vibrate' in navigator) navigator.vibrate(0);
}
$('inputFotoConfirmacion')?.addEventListener('change', async e => {
  const archivo = e.target.files?.[0];
  if (!archivo || !medicamentoEnAlerta) return;
  if ($('mensajeAlerta')) $('mensajeAlerta').textContent = 'Guardando confirmación...';
  try {
    await fetchAPI(`/medicamentos/${medicamentoEnAlerta.id}/confirmar/`, { method: 'POST' });
    if ($('mensajeAlerta')) $('mensajeAlerta').textContent = 'Toma confirmada.';
    detenerAlarma();
    await cargarMedicamentos();
    setTimeout(() => { $('alertaPastilla')?.classList.add('hidden'); medicamentoEnAlerta = null; e.target.value = ''; }, 1500);
  } catch (error) {
    console.error('Error confirmando toma:', error);
    if ($('mensajeAlerta')) $('mensajeAlerta').textContent = error.message || 'No se pudo conectar con el servidor.';
  }
});
