const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// ── Configurações ──────────────────────────────────────────────
const SUPABASE_URL = 'https://wgxknosznfpoaluryqcn.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY; // coloque na variável de ambiente do Railway
const EVOLUTION_URL = 'https://evolution-api-production-5b7e.up.railway.app';
const EVOLUTION_INSTANCE = 'teste';
const EVOLUTION_APIKEY = 'mude-me';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Mapa dias da semana pt-BR → número JS (0=Dom, 1=Seg, ..., 6=Sab)
const DIAS = {
  dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6,
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
  0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6,
};

// ── Envia mensagem via Evolution API ──────────────────────────
async function enviarWhatsApp(phone, message) {
  const numero = phone.replace(/\D/g, ''); // remove não-dígitos
  const url = `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': EVOLUTION_APIKEY,
    },
    body: JSON.stringify({
      number: numero,
      text: message,
    }),
  });

  const json = await res.json();
  return json;
}

// ── Registra log de envio ──────────────────────────────────────
async function registrarLog(msgId, status, erro = null) {
  await supabase.from('message_logs').insert({
    scheduled_message_id: msgId,
    status,
    error: erro,
    sent_at: new Date().toISOString(),
  });
}

// ── Lógica principal ───────────────────────────────────────────
async function verificarEDisparar() {
  const agora = new Date();
  const horaAtual = agora.toTimeString().slice(0, 5); // "HH:MM"
  const diaAtual = agora.getDay(); // 0-6

  console.log(`[${agora.toISOString()}] Verificando agendamentos — ${horaAtual} dia ${diaAtual}`);

  // Busca mensagens ativas com o telefone do contato
  const { data: msgs, error } = await supabase
    .from('scheduled_messages')
    .select(`
      id,
      message,
      send_time,
      days_of_week,
      one_time,
      sent_once,
      contacts (phone, name)
    `)
    .eq('active', true);

  if (error) {
    console.error('Erro ao buscar agendamentos:', error.message);
    return;
  }

  for (const msg of msgs) {
    try {
      // Verifica horário (compara HH:MM)
      const horaMensagem = msg.send_time?.slice(0, 5);
      if (horaMensagem !== horaAtual) continue;

      // Verifica dia da semana
      const dias = msg.days_of_week
        ?.split(',')
        .map(d => DIAS[d.trim().toLowerCase()])
        .filter(d => d !== undefined);

      if (!dias || !dias.includes(diaAtual)) continue;

      // Se for mensagem única e já foi enviada, pula
      if (msg.one_time && msg.sent_once) continue;

      const phone = msg.contacts?.phone;
      if (!phone) {
        console.warn(`Contato sem telefone — msg ID ${msg.id}`);
        continue;
      }

      console.log(`→ Disparando para ${msg.contacts.name} (${phone})`);
      const resultado = await enviarWhatsApp(phone, msg.message);
      console.log('  Resultado:', JSON.stringify(resultado));

      // Registra log
      await registrarLog(msg.id, 'sent');

      // Se for mensagem única, marca como enviada
      if (msg.one_time) {
        await supabase
          .from('scheduled_messages')
          .update({ sent_once: true, active: false })
          .eq('id', msg.id);
      }

    } catch (err) {
      console.error(`Erro ao processar msg ID ${msg.id}:`, err.message);
      await registrarLog(msg.id, 'error', err.message);
    }
  }
}

// ── Cron: roda a cada minuto ───────────────────────────────────
cron.schedule('* * * * *', verificarEDisparar);

console.log('✅ Scheduler iniciado — verificando a cada minuto');
