// API_BASE_URL se define en config.js (cargado antes que este archivo).
const $ = id => document.getElementById(id);
let token = localStorage.getItem('taco_token') || null;
let refreshToken = localStorage.getItem('taco_refresh') || null;
const API = `${String(API_BASE_URL).trim().replace(/\/+$/, '')}/api/v1`;   // tolera una "/" final en config.js
let idUsuario = localStorage.getItem('taco_id') || null;
let listaMedicamentosActual = [];
let medicamentoEnAlerta = null;
let intervaloAlertas = null;
let inrPendiente = null;
let sesion = 0;
const vistaAuth = $('vistaAuth');
const vistaPanel = $('vistaPanel');
const formLogin = $('formLogin');
const formRegistro = $('formRegistro');

function nombreEnPantalla(nombre) {
  const texto = String(nombre || '').trim() || 'Paciente';
  if ($('nombrePaciente')) $('nombrePaciente').textContent = texto;
  if ($('nombreUsuarioPanel')) $('nombreUsuarioPanel').textContent = texto;
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
  pintarReporte([]);
}
function mostrarPanel() {
  sesion++;
  vistaAuth?.classList.add('hidden');
  vistaPanel?.classList.remove('hidden');
  nombreEnPantalla(localStorage.getItem('taco_nombre'));
  reiniciarResumen();
  cargarHistorial();
  cargarMedicamentos();
  pedirPermisoNotificaciones();
  iniciarRevisionDeAlertas();
}
function mostrarAuth() {
  sesion++;
  vistaPanel?.classList.add('hidden');
  vistaAuth?.classList.remove('hidden');
  $('alertaPastilla')?.classList.add('hidden');
  medicamentoEnAlerta = null;
  inrPendiente = null;
  if (intervaloAlertas) { clearInterval(intervaloAlertas); intervaloAlertas = null; }
}
function aplanarDetalles(detalles) {
  if (!detalles) return [];
  if (typeof detalles === 'string') return [detalles];
  if (Array.isArray(detalles)) return detalles.flatMap(aplanarDetalles);
  return Object.entries(detalles).flatMap(([campo, valor]) => aplanarDetalles(valor).map(m => `${campo}: ${m}`));
}
function mensajeError(datos, predeterminado) {
  const detalle = datos?.mensaje || datos?.error || datos?.detail;
  const lista = aplanarDetalles(datos?.detalles);
  if (lista.length) return lista.join(' | ');
  return typeof detalle === 'string' ? detalle : detalle ? JSON.stringify(detalle) : predeterminado;
}
async function leerJSON(res) {
  const texto = await res.text();
  if (!texto) return {};
  try {
    const cuerpo = JSON.parse(texto);
    if (cuerpo?.ok === false) return { error: cuerpo.error?.message || 'Error en la solicitud.', detalles: cuerpo.error?.details };
    if (cuerpo?.ok === true) return cuerpo.data;   // desenvuelve {ok, status, data}
    return cuerpo;
  } catch { return { error: `Respuesta no JSON del servidor (HTTP ${res.status}).` }; }
}
async function renovarToken() {
  if (!refreshToken) return false;
  try {
    const res = await fetch(`${API}/auth/refresh/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh: refreshToken })
    });
    const datos = await leerJSON(res);
    if (!res.ok || !datos.access) return false;
    token = datos.access;
    if (datos.refresh) refreshToken = datos.refresh;   // el servidor rota el refresh token
    localStorage.setItem('taco_token', token);
    if (refreshToken) localStorage.setItem('taco_refresh', refreshToken);
    return true;
  } catch { return false; }
}
async function apiFetch(ruta, opciones = {}) {
  const enviar = () => fetch(`${API}${ruta}`, {
    ...opciones, headers: { ...(opciones.headers || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
  });
  let res = await enviar();
  if (res.status === 401 && token) {
    if (await renovarToken()) res = await enviar();
    else { cerrarSesion(false); }
  }
  return res;
}
function cerrarSesion(avisarAlServidor = true) {
  if (avisarAlServidor && token && refreshToken) {   // invalida el refresh token en el servidor
    fetch(`${API}/auth/logout/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ refresh: refreshToken })
    }).catch(() => {});
  }
  ['taco_token', 'taco_refresh', 'taco_id', 'taco_nombre'].forEach(k => localStorage.removeItem(k));
  token = null; refreshToken = null; idUsuario = null; listaMedicamentosActual = []; inrPendiente = null;
  contadorMedicamentos(); nombreEnPantalla('Paciente'); pintarReporte([]); mostrarAuth();
}
function seguroHTML(valor) {
  return String(valor).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function numeroSeguro(valor) {
  if (typeof valor !== 'string' && typeof valor !== 'number') return null;
  const texto = String(valor).trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(texto)) return null;
  const numero = Number(texto);
  return Number.isFinite(numero) && numero > 0 && numero < 20 ? numero : null;
}
function rangoSeguro(texto) {
  if (typeof texto !== 'string') return null;
  const coincidencias = texto.match(/\d+(?:[.,]\d+)?/g);
  if (!coincidencias || coincidencias.length !== 2) return null;
  const min = numeroSeguro(coincidencias[0]);
  const max = numeroSeguro(coincidencias[1]);
  return min !== null && max !== null && min < max ? { min, max } : null;
}
function fechaVisible(registro) {
  const valor = registro.fechaLectura || registro.fecha_lectura || registro.fecha;
  if (!valor) return 'Fecha no disponible';
  const fecha = new Date(valor);
  return Number.isNaN(fecha.getTime()) ? 'Fecha no disponible' : fecha.toLocaleDateString('es-CL');
}
function pintarReporte(registros) {
  const ultimo = registros[0];
  const valor = ultimo ? numeroSeguro(ultimo.valorINR) : null;
  if ($('ultimoINRPanel')) $('ultimoINRPanel').textContent = valor === null ? '—' : String(ultimo.valorINR);
  if ($('ultimoRangoPanel')) $('ultimoRangoPanel').textContent = ultimo ? `${ultimo.rangoTerapeuticoMin ?? '—'} - ${ultimo.rangoTerapeuticoMax ?? '—'}` : '—';
  const resumen = $('reporteResumen');
  if (resumen) resumen.textContent = registros.length ? `${registros.length} lectura(s) guardada(s). Última: INR ${ultimo.valorINR} (${fechaVisible(ultimo)}).` : 'Aún no tienes lecturas INR guardadas.';
  const svg = $('graficoINR'), vacio = $('graficoINRVacio'), fechas = $('graficoINRFechas');
  const lecturas = registros.filter(r => numeroSeguro(r.valorINR) !== null).slice(0, 6).reverse();
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
  if ($('graficoINRArea')) $('graficoINRArea').setAttribute('d', area);
  if ($('graficoINRLinea')) $('graficoINRLinea').setAttribute('points', coordenadas);
  const grupo = $('graficoINRPuntos');
  if (grupo) {
    grupo.replaceChildren();
    puntos.forEach((p, i) => {
      const circulo = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circulo.setAttribute('cx', p.x.toFixed(1)); circulo.setAttribute('cy', p.y.toFixed(1));
      circulo.setAttribute('r', '5'); circulo.setAttribute('class', 'inr-punto');
      const titulo = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titulo.textContent = `${fechaVisible(lecturas[i])}: INR ${lecturas[i].valorINR}`;
      circulo.append(titulo); grupo.append(circulo);
    });
  }
  if (fechas) {
    fechas.replaceChildren();
    lecturas.forEach(r => { const span = document.createElement('span'); span.textContent = fechaVisible(r); fechas.append(span); });
  }
}
if (token && idUsuario) mostrarPanel();

// El giro 3D entre formularios se encuentra en index.html.
formLogin?.addEventListener('submit', async e => {
  e.preventDefault();
  const mensaje = $('mensajeAuth');
  if (mensaje) mensaje.textContent = 'Conectando con el servidor… si estaba inactivo, la primera vez puede tardar hasta 1 minuto.';
  try {
    const res = await fetch(`${API}/auth/login/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('loginEmail').value.trim(), password: $('loginPassword').value })
    });
    const datos = await leerJSON(res);
    if (mensaje) mensaje.textContent = '';
    if (!res.ok) { if (mensaje) mensaje.textContent = mensajeError(datos, 'Credenciales incorrectas'); return; }
    const nuevoId = datos.usuario?.id ?? datos.usuario?.idUsuario ?? datos.idUsuario;
    if (!datos.access || !nuevoId) {
      if (mensaje) mensaje.textContent = 'El servidor no devolvió el token o el ID del usuario.';
      return;
    }
   // Guardar credenciales en el almacenamiento local
  token = datos.access;
  refreshToken = datos.refresh || null;
  idUsuario = nuevoId;

  localStorage.setItem('taco_token', token);
  if (refreshToken) localStorage.setItem('taco_refresh', refreshToken);
  localStorage.setItem('taco_id', String(idUsuario));
  localStorage.setItem('taco_nombre', datos.usuario?.nombre ?? 'Paciente');

  // Reproducir la intro y pasar al panel cuando el video finalice
  reproducirIntro(function() {
    mostrarPanel();
  });
  } catch (error) {
    console.error('Error al iniciar sesión:', error);
    if (mensaje) mensaje.textContent = 'No se pudo conectar con el servidor. Revisa tu internet o espera 1 minuto y reintenta.';
  }
});
formRegistro?.addEventListener('submit', async e => {
  e.preventDefault();
  const mensaje = $('mensajeRegistro');
  if (mensaje) mensaje.textContent = 'Conectando con el servidor… si estaba inactivo, la primera vez puede tardar hasta 1 minuto.';
  try {
    const res = await fetch(`${API}/auth/registro/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: $('regNombre').value.trim(), email: $('regEmail').value.trim(), password: $('regPassword').value })
    });
    const datos = await leerJSON(res);
    if (mensaje) mensaje.textContent = '';
    if (!res.ok) { if (mensaje) mensaje.textContent = mensajeError(datos, 'No se pudo crear la cuenta.'); return; }
    formRegistro.reset(); $('tabLogin')?.click();
    setTimeout(() => { if ($('mensajeAuth')) $('mensajeAuth').textContent = 'Cuenta creada. Ahora inicia sesión.'; }, 850);
  } catch (error) {
    console.error('Error en registro:', error);
    if (mensaje) mensaje.textContent = 'No se pudo conectar con el servidor. Revisa tu internet o espera 1 minuto y reintenta.';
  }
});
$('btnSalir')?.addEventListener('click', () => cerrarSesion(true));

$('formReceta')?.addEventListener('submit', async e => {
  e.preventDefault();
  const archivo = $('inputImagen')?.files?.[0];
  const mensaje = $('mensajeReceta'), resultado = $('resultadoAlerta');
  const boton = $('formReceta')?.querySelector('button[type="submit"]');
  if (!archivo) { if (mensaje) mensaje.textContent = 'Selecciona una imagen primero.'; return; }
  if (!token) { if (mensaje) mensaje.textContent = 'Inicia sesión para analizar la receta.'; return; }
  const textoBoton = boton?.textContent;
  if (boton) { boton.disabled = true; boton.textContent = 'Analizando...'; }
  if (mensaje) mensaje.textContent = 'Analizando imagen con Gemini...';
  resultado?.classList.add('hidden'); inrPendiente = null;
  if ($('btnGuardarINR')) $('btnGuardarINR').disabled = true;
  const formData = new FormData(); formData.append('imagen', archivo);
  try {
    const res = await apiFetch('/recetas/analizar/', { method: 'POST', body: formData });
    const datos = await leerJSON(res);
    if (!res.ok) { if (mensaje) mensaje.textContent = `Error ${res.status}: ${mensajeError(datos, 'No se pudo analizar la imagen.')}`; return; }
    const inr = datos.inr_actual ?? null, rango = datos.rango_terapeutico ?? null;
    const medicamentos = Array.isArray(datos.medicamentos) ? datos.medicamentos : [];
    if (resultado) {
      const estado = resultado.querySelector('.resultado-estado'), detalle = resultado.querySelector('.resultado-detalle');
      if (estado) estado.textContent = 'Imagen analizada; comprueba los valores con la hoja original';
      if (detalle) detalle.textContent = `INR: ${inr ?? 'No legible'} | Rango: ${rango ?? 'No legible'} | Medicamentos detectados: ${medicamentos.length}`;
      resultado.classList.remove('hidden');
    }
    const valor = numeroSeguro(inr), limites = rangoSeguro(rango);
    if (valor !== null && limites) {
      inrPendiente = { valorINR: valor, rangoTerapeuticoMin: limites.min, rangoTerapeuticoMax: limites.max };
      if ($('btnGuardarINR')) $('btnGuardarINR').disabled = false;
    }
    if (medicamentos.length) {
      const med = medicamentos[0];
      if ($('medNombre')) $('medNombre').value = med.nombre || '';
      if ($('medUnidad')) $('medUnidad').value = '';
      if ($('medHora')) $('medHora').value = '';
      const dosis = med.dosis_diaria || {};
      const dias = { lunes:'dia-lunes', martes:'dia-martes', miercoles:'dia-miercoles', jueves:'dia-jueves', viernes:'dia-viernes', sabado:'dia-sabado', domingo:'dia-domingo' };
      for (const [dia, id] of Object.entries(dias)) if ($(id)) $(id).value = dosis[dia] ?? '';
    }
    const avisos = [];
    if (!inrPendiente) avisos.push('INR o rango no legible: no se puede guardar el registro.');
    if (medicamentos.length) avisos.push('Revisa las dosis. Completa unidad y hora antes de guardar el medicamento.');
    if (medicamentos.length > 1) avisos.push(`Se detectaron ${medicamentos.length} medicamentos; el formulario solo muestra el primero.`);
    if (!medicamentos.length) avisos.push('No se detectaron medicamentos.');
    if (mensaje) mensaje.textContent = avisos.join(' ');
    $('herramientaReceta')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { console.error('Error analizando receta:', error); if (mensaje) mensaje.textContent = 'No se pudo conectar con Django. Revisa el servidor.'; }
  finally { if (boton) { boton.disabled = false; boton.textContent = textoBoton; } }
});

$('btnGuardarINR')?.addEventListener('click', async () => {
  const mensaje = $('mensajeGuardarINR');
  if (!token || !inrPendiente) return;
  const dato = { ...inrPendiente };
  if (!window.confirm(`Confirma con la hoja original:\nINR: ${dato.valorINR}\nRango: ${dato.rangoTerapeuticoMin} - ${dato.rangoTerapeuticoMax}\n\n¿Guardar como lectura transcrita, SIN evaluación clínica?`)) return;
  const boton = $('btnGuardarINR'); boton.disabled = true;
  if (mensaje) mensaje.textContent = 'Guardando INR...';
  try {
    const res = await apiFetch('/registros-inr/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dato)
    });
    const datos = await leerJSON(res);
    if (!res.ok) { if (mensaje) mensaje.textContent = mensajeError(datos, 'No se pudo guardar el INR.'); boton.disabled = false; return; }
    inrPendiente = null;
    if (mensaje) mensaje.textContent = 'INR guardado como lectura transcrita. No indica una recomendación de tratamiento.';
    await cargarHistorial();
  } catch (error) { console.error('Error guardando INR:', error); if (mensaje) mensaje.textContent = 'No se pudo conectar con Django.'; boton.disabled = false; }
});

$('formMedicamento')?.addEventListener('submit', async e => {
  e.preventDefault(); if (!token) return;
  const form = $('formMedicamento');
  const dosis = dia => ($(`dia-${dia}`)?.value || '').trim();
  const payload = {
    nombre: $('medNombre')?.value.trim() || '', unidadPastilla: $('medUnidad')?.value.trim() || '',
    horaProgramada: $('medHora')?.value || '', periodicidad: 'semanal',
    horarioSemanal: {
      lunes: dosis('lunes'), martes: dosis('martes'), miercoles: dosis('miercoles'), jueves: dosis('jueves'),
      viernes: dosis('viernes'), sabado: dosis('sabado'), domingo: dosis('domingo')
    }
  };
  try {
    const res = await apiFetch('/medicamentos/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const datos = await leerJSON(res);
    if (!res.ok) { alert(mensajeError(datos, 'No se pudo guardar el tratamiento.')); return; }
    form.reset(); if ($('medHora')) $('medHora').value = '17:00';
    await cargarMedicamentos(); alert('Tratamiento guardado.');
  } catch (error) { console.error('Error al guardar:', error); alert('No se pudo conectar con Django.'); }
});
async function cargarMedicamentos() {
  const lista = $('listaMedicamentos'); if (!lista || !token) return;
  const sesionAlSolicitar = sesion;
  lista.innerHTML = '<li>Cargando medicamentos...</li>';
  try {
    const res = await apiFetch('/medicamentos/?page_size=100');
    const datos = await leerJSON(res);
    if (sesionAlSolicitar !== sesion) return;
    if (!res.ok) { lista.innerHTML = `<li>${seguroHTML(mensajeError(datos, 'No se pudieron cargar medicamentos.'))}</li>`; return; }
    listaMedicamentosActual = Array.isArray(datos?.results) ? datos.results : Array.isArray(datos) ? datos : [];
    contadorMedicamentos();
    if (!listaMedicamentosActual.length) { lista.innerHTML = '<li>No tienes medicamentos registrados.</li>'; return; }
    lista.innerHTML = listaMedicamentosActual.map(m => `<li><article class="medicamento-item"><h3>${seguroHTML(m.nombre || 'Medicamento')}</h3><p>Hora de toma: ${seguroHTML(m.hora_toma || m.horaProgramada || 'No indicada')}</p><p>Unidad: ${seguroHTML(m.unidad_base || m.unidadPastilla || 'No indicada')}</p></article></li>`).join('');
  } catch (error) { if (sesionAlSolicitar !== sesion) return; console.error('Error cargando medicamentos:', error); lista.innerHTML = '<li>Error de conexión al cargar medicamentos.</li>'; }
}
async function cargarHistorial() {
  const lista = $('listaHistorial'); if (!lista || !token) return;
  const sesionAlSolicitar = sesion;
  lista.innerHTML = '<li>Cargando historial...</li>';
  try {
    const res = await apiFetch('/registros-inr/?page_size=50');
    const datos = await leerJSON(res);
    if (sesionAlSolicitar !== sesion) return;
    if (!res.ok) { lista.innerHTML = `<li>${seguroHTML(mensajeError(datos, 'No se pudo cargar el historial.'))}</li>`; if ($('reporteResumen')) $('reporteResumen').textContent = 'No se pudo cargar el reporte INR.'; return; }
    const registros = Array.isArray(datos?.results) ? datos.results : Array.isArray(datos) ? datos : [];
    pintarReporte(registros);
    if (!registros.length) { lista.innerHTML = '<li>No hay registros INR guardados.</li>'; return; }
    lista.innerHTML = registros.map(r => `<li><article class="historial-item"><p><strong>Fecha:</strong> ${seguroHTML(fechaVisible(r))}</p><p><strong>INR:</strong> ${seguroHTML(r.valorINR ?? 'N/A')}</p><p><strong>Rango:</strong> ${seguroHTML(r.rangoTerapeuticoMin ?? 'N/A')} - ${seguroHTML(r.rangoTerapeuticoMax ?? 'N/A')}</p><p class="muted">Lectura transcrita; sin evaluación clínica.</p></article></li>`).join('');
  } catch (error) { if (sesionAlSolicitar !== sesion) return; console.error('Error cargando historial:', error); lista.innerHTML = '<li>Error de conexión al cargar historial.</li>'; if ($('reporteResumen')) $('reporteResumen').textContent = 'No se pudo cargar el reporte INR.'; }
}
$('btnActualizarHistorial')?.addEventListener('click', cargarHistorial);
document.getElementById('btnGenerarQR')?.addEventListener('click', function () {
  const qrContainer = document.getElementById('qrcode-container');
  if (!qrContainer) return;
  
  qrContainer.innerHTML = ""; // Limpiar QR previo

  // Formato estructurado compatible con cualquier escáner de teléfono
  const datosEmergencia = "FICHA MEDICA DE EMERGENCIA\n" +
                          "Paciente: Natalia\n" +
                          "Tratamiento: TACO (Anticoagulante)\n" +
                          "Ultimo INR: 2.5\n" +
                          "Contacto: +56912345678";

  new QRCode(qrContainer, {
    text: datosEmergencia,
    width: 160,
    height: 160,
  colorDark:"#007A5E",
    colorLight:"#ffffff",
    correctLevel: QRCode.CorrectLevel.H // Alta tolerancia a errores para mejor lectura
  });
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
  const hora = `${String(ahora.getHours()).padStart(2,'0')}:${String(ahora.getMinutes()).padStart(2,'0')}`;
  const dia = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'][ahora.getDay()];
  const med = listaMedicamentosActual.find(item => {
    const horario = item.horarioSemanal || {};
    const dosis = item[`dosis_${dia}`] ?? horario[dia];
    const horaGuardada = item.hora_toma || item.horaProgramada || '';
    return String(horaGuardada).slice(0, 5) === hora && dosis;
  });
  if (med) mostrarAlertaPastilla(med);
}
function mostrarAlertaPastilla(med) {
  medicamentoEnAlerta = med;
  if ($('alertaNombreMed')) $('alertaNombreMed').textContent = `Es hora de: ${med.nombre || 'tu medicamento'}`;
  if ($('alertaDosisMed')) $('alertaDosisMed').textContent = 'Revisa tu hoja de dosificación para hoy.';
  if ($('mensajeAlerta')) $('mensajeAlerta').textContent = '';
  $('alertaPastilla')?.classList.remove('hidden');
  if ('Notification' in window && Notification.permission === 'granted') new Notification('HealthTech TACO', { body:`Es hora de tomar ${med.nombre || 'tu medicamento'}` });
}
$('inputFotoConfirmacion')?.addEventListener('change', async e => {
  if (!e.target.files?.[0] || !medicamentoEnAlerta) return;
  const entrada = e.target, med = medicamentoEnAlerta;
  if ($('mensajeAlerta')) $('mensajeAlerta').textContent = 'Registrando tu toma...';
  let texto = 'No se pudo registrar la toma en el servidor.';
  try {
    const res = await apiFetch(`/medicamentos/${med.id}/confirmar/`, { method: 'POST' });
    texto = res.ok ? 'Toma registrada correctamente.' : mensajeError(await leerJSON(res), texto);
  } catch (error) { console.error('Error confirmando toma:', error); }
  if ($('mensajeAlerta')) $('mensajeAlerta').textContent = texto;
  setTimeout(() => { $('alertaPastilla')?.classList.add('hidden'); medicamentoEnAlerta = null; entrada.value = ''; }, 2000);
});
document.getElementById('btnGenerarQR')?.addEventListener('click', function () {
  const qrContainer = document.getElementById('qrcode-container');
  if (!qrContainer) return;

  qrContainer.innerHTML = ""; // Limpiar QR previo

  // Formato vCard estándar: los celulares lo leen como "Añadir Contacto / Ficha de Emergencia"
  const datosEmergencia = 
    "BEGIN:VCARD\n" +
    "VERSION:3.0\n" +
    "FN:EMERGENCIA - Natalia (TACO)\n" +
    "NOTE:Paciente TACO | Ultimo INR: 2.5\n" +
    "TEL:+56912345678\n" +
    "END:VCARD";

  new QRCode(qrContainer, {
    text: datosEmergencia,
    width: 180,
    height: 180,
    colorDark: "#007A5E",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M
  });
});
function reproducirIntro(alTerminar) {
  const splash = document.getElementById('splash-screen');
  const video = document.getElementById('intro-video');
  if (!splash || !video) { if (alTerminar) alTerminar(); return; }

  let terminado = false;
  let respaldo = null;
  const terminar = function () {
    if (terminado) return;          // evita ejecutarse dos veces
    terminado = true;
    clearTimeout(respaldo);
    video.removeEventListener('ended', terminar);
    video.pause();
      document.body.classList.remove('intro-activa');
    splash.classList.add('hidden');
    if (alTerminar) alTerminar();   // recién aquí se muestra el panel del paciente
  };

  video.addEventListener('ended', terminar);   // se cierra cuando el video TERMINA, no por tiempo fijo
    document.body.classList.add('intro-activa');
  splash.classList.remove('hidden');
  video.currentTime = 0;
  video.muted = true;
  video.play().catch(function (e) {
    console.warn('No se pudo reproducir la intro:', e);
    terminar();                     // si el navegador la bloquea, no dejamos al usuario atrapado
  });

  // Respaldo de seguridad: duración real del video + 3 segundos
  const duracion = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 8;
  respaldo = setTimeout(terminar, (duracion + 3) * 1000);
}
// ---------------------------------------------------------------------------
// Pantalla de acceso: cambio entre "Iniciar sesión" y "Crear cuenta" (tarjeta que gira),
// ojo de la contraseña y botones secundarios. Sin esto, "Crear cuenta" no hace nada.
// ---------------------------------------------------------------------------
(function () {
  const tarjeta = $('flipCard');
  const caraLogin = $('caraLogin');
  const caraRegistro = $('caraRegistro');
  let temporizador = null;

  function mostrarCara(registro) {
    if (!tarjeta || !caraLogin || !caraRegistro) return;
    tarjeta.classList.add('is-animating');             // mantiene visibles ambas caras durante el giro
    tarjeta.classList.toggle('is-flipped', registro);
    caraLogin.setAttribute('aria-hidden', String(registro));
    caraRegistro.setAttribute('aria-hidden', String(!registro));
    caraLogin.inert = registro;                         // la cara oculta no recibe foco ni clics
    caraRegistro.inert = !registro;
    ['mensajeAuth', 'mensajeRegistro'].forEach(id => { if ($(id)) $(id).textContent = ''; });
    clearTimeout(temporizador);
    temporizador = setTimeout(() => {
      tarjeta.classList.remove('is-animating');
      const primero = $(registro ? 'regNombre' : 'loginEmail');
      if (primero) primero.focus({ preventScroll: true });
    }, 850);
  }

  $('tabRegistro')?.addEventListener('click', () => mostrarCara(true));
  $('tabLogin')?.addEventListener('click', () => mostrarCara(false));

  // Ojo: mostrar / ocultar contraseña
  document.querySelectorAll('.toggle-eye').forEach(boton => {
    boton.addEventListener('click', () => {
      const campo = $(boton.dataset.target);
      if (!campo) return;
      const mostrar = campo.type === 'password';
      campo.type = mostrar ? 'text' : 'password';
      boton.setAttribute('aria-label', mostrar ? 'Ocultar contraseña' : 'Mostrar contraseña');
    });
  });

  // Funciones que el backend aún no ofrece: se avisa en lugar de dejar el botón "muerto"
  $('linkOlvideContrasena')?.addEventListener('click', e => {
    e.preventDefault();
    if ($('mensajeAuth')) $('mensajeAuth').textContent = 'La recuperación de contraseña aún no está disponible. Contacta al administrador.';
  });
  document.querySelectorAll('.btn-social').forEach(boton => {
    boton.addEventListener('click', () => {
      const id = boton.closest('#caraRegistro') ? 'mensajeRegistro' : 'mensajeAuth';
      if ($(id)) $(id).textContent = 'El acceso con Google o Apple estará disponible próximamente.';
    });
  });
})();
