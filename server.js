// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');


const app = express();
const port = process.env.PORT || 3001;
app.use(cors({
  origin: 'http://localhost:5173',
  methods: ['GET', 'POST', 'DELETE', 'PUT'],
  allowedHeaders: ['Content-Type']
}));

//Mideleware
app.use(express.json());

// Configura Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Diagnóstico básico de entorno
if (!supabaseUrl || !supabaseKey) {
  console.error('[ENV] Faltan variables SUPABASE_URL o SUPABASE_KEY');
} else {
  console.log('[ENV] SUPABASE_URL y SUPABASE_KEY presentes');
}



// Ruta de prueba
app.get('/api/hello', (req, res) => {
  res.json({ message: 'CRM de pádel funcionando 🎾' });
});

// Obtener todos los alumnos
app.get('/api/alumnos', async (req, res) => {
  const { data, error } = await supabase.from('alumnos').select('*');
  if (error) {
    console.error('[SUPABASE] Error en select alumnos:', error);
    return res.status(500).json({ error: error.message });
  }
  if (Array.isArray(data) && data.length === 0) {
    console.warn('[SUPABASE] Select alumnos devolvió array vacío. Posibles causas: RLS bloquea SELECT, tabla vacía o nombre/esquema incorrecto.');
  }
  res.set('Cache-Control', 'no-store');
  res.json(data);
});

//Endpoint alumno
app.post('/api/alumnos', async (req, res) => {
  const { nombre, email, telefono, nivel } = req.body;
  if(!nombre || !telefono || !nivel) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }
  const { data, error } = await supabase.from('alumnos').insert({ nombre, email, telefono, nivel:nivel ||'Iniciación (1)', activo:true });

  if (error) {
    console.error('[SUPABASE] Error en insert alumnos:', error);
    return res.status(500).json({ error: error.message });
  }
  res.status(201).json({message: 'Alumno creado correctamente', data});
});

// PUT /api/alumnos/:id - Editar alumno
app.put('/api/alumnos/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, email, telefono, nivel } = req.body;
  const { data, error,count } = await supabase
    .from('alumnos')
    .update({ nombre, email, telefono, nivel })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(404).json({ error: 'Alumno no encontrado' });
  res.json({ message: 'Alumno actualizado', data });
});

// DELETE /api/alumnos/:id - Eliminar alumno
app.delete('/api/alumnos/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('alumnos').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Alumno eliminado' });
});


//Endpoint pagos
app.get('/api/pagos', async (req, res) => {
  const { data, error } = await supabase
    .from('pagos')
    .select(`id,cantidad,mes_cubierto,metodo,fecha_pago,alumno_id, alumnos(id,nombre)`)
    .order('fecha_pago', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  const pagosConNombre = data.map(pago => ({
    ...pago,
    nombre_alumno: pago.alumnos?.nombre || 'Alumno eliminado'
  }));
  res.json(pagosConNombre);
})

app.post('/api/pagos', async (req, res) => {
  const { alumno_id, cantidad, mes_cubierto, metodo, fecha_pago } = req.body;
  if (!alumno_id || !cantidad || !mes_cubierto) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios' });
  }
  const { data, error } = await supabase
    .from('pagos')
    .insert([
      { alumno_id, cantidad, mes_cubierto, metodo: metodo || 'Transferencia',fecha_pago }
    ]);
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ message: 'Pago registrado', data });
});

// Endpoint clases

app.get('/api/clases', async (req, res) => {
  const { data, error } = await supabase
    .from('clases')
    .select('*')
    .order('dia_semana');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/alumnos-clases - Alumnos por clase
app.get('/api/alumnos-clases', async (req, res) => {
  const { data, error } = await supabase
    .from('alumnos_clases')
    .select(`
      id,
      alumno_id,
      clase_id,
      alumnos (nombre)
    `);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/clases - Crear clase
app.post('/api/clases', async (req, res) => {
  const { nombre, dia_semana, hora_inicio, hora_fin, nivel, profesor } = req.body;

  if (!nombre || !dia_semana || !hora_inicio || !hora_fin || !nivel) {
    return res.status(400).json({ error: 'Todos los campos obligatorios' });
  }

  const { data, error } = await supabase
    .from('clases')
    .insert([{ nombre, dia_semana, hora_inicio, hora_fin, nivel, profesor }]);

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ message: 'Clase creada', data });
});

// PUT /api/clases/:id - Editar clase
app.put('/api/clases/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, dia_semana, hora_inicio, hora_fin, nivel, profesor } = req.body;

  const { data, error } = await supabase
    .from('clases')
    .update({ nombre, dia_semana, hora_inicio, hora_fin, nivel, profesor })
    .eq('id', id);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Clase actualizada', data });
});

// DELETE /api/clases/:id - Eliminar clase
app.delete('/api/clases/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('clases').delete().eq('id', id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Clase eliminada' });
});


//Endpoint asignación de alumnos

// POST /api/asignar-alumno - Asignar alumno a clase
app.post('/api/asignar-alumno', async (req, res) => {
  const { alumno_id, clase_id } = req.body;
  const { data, error } = await supabase
    .from('alumnos_clases')
    .insert([{ alumno_id, clase_id }]);
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ message: 'Alumno asignado' });
});

// DELETE /api/desasignar-alumno - Quitar alumno de clase
app.delete('/api/desasignar-alumno/:alumno_id/:clase_id', async (req, res) => {
  const { alumno_id, clase_id } = req.params;
  const { error } = await supabase
    .from('alumnos_clases')
    .delete()
    .eq('alumno_id', alumno_id)
    .eq('clase_id', clase_id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ message: 'Alumno desasignado' });
});


//POST /api/asistencia -Registrar asistencia
app.post('/api/asistencia', async (req, res) => {
  const { alumno_id, clase_id, fecha, estado } = req.body;
  const { data, error } = await supabase
    .from('asistencias')
    .insert([{ alumno_id, clase_id, fecha, estado }]);
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ message: 'Asistencia registrada' });
});

//GET /api/asistencia
app.get('/api/asistencia', async (req, res) => {
  const { fecha, alumno_id } = req.query;
  let query = supabase.from('asistencias').select(`*,alumnos(nombre), clases(nombre)`);
  if (fecha) query = query.eq('fecha', fecha);
  if (alumno_id) query = query.eq('alumno_id', alumno_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
})

app.listen(port, () => {
  console.log(`Servidor corriendo en http://localhost:${port}`);
});