const express = require('express');
const fetch = require('node-fetch');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

// ── Config ────────────────────────────────────────────────────
const SUPABASE_URL  = 'https://cgwwagojwhnwgcvanpbp.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const EVO_URL       = 'https://evolution-api-production-5b7e.up.railway.app';
const EVO_KEY       = 'TESTE2';
const EVO_INSTANCE  = 'teste';
const PORT          = process.env.PORT || 3001;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const app = express();

// ── CORS ──────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, apikey');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── Evolution API proxy ───────────────────────────────────────
async function evoProxy(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { apikey: EVO_KEY, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${EVO_URL}${path}`, opts);
  return r.json();
}

// ── API Routes ────────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'ok', service: 'GL CRM API + Scheduler' }));

app.get('/conversas', async (req, res) => {
  try {
    const [chats, contacts] = await Promise.all([
      evoProxy(`/chat/findChats/${EVO_INSTANCE}`),
      evoProxy(`/contacts/fetchContacts/${EVO_INSTANCE}`).catch(() => []),
    ]);
    const list = Array.isArray(chats) ? chats : (chats?.chats || chats?.data || []);
    const contactList = Array.isArray(contacts) ? contacts : (contacts?.data || []);

    const contactMap = {};
    contactList.forEach(c => {
      const jid = c.remoteJid || c.id || '';
      const name = c.pushName || c.name || '';
      if (jid && name) contactMap[jid] = name;
    });

    const conversas = list.slice(0, 50)
      .filter(ch => {
        const id = ch.remoteJid || ch.id?.remote || ch.id || '';
        return !id.includes('@g.us') && !id.includes('@lid') && !id.includes('@broadcast');
      })
      .map(ch => {
        const id = ch.remoteJid || ch.id?.remote || ch.id || '';
        const phone = id.replace('@s.whatsapp.net', '');
        const name = contactMap[id] || ch.name || ch.pushName || phone;
        const lastMsgObj = ch.lastMessage || ch.messages?.upsert?.[0];
        const lastMsg = lastMsgObj?.message?.conversation || lastMsgObj?.message?.extendedTextMessage?.text || '';
        return { id, name, phone, lastMsg, unread: ch.unreadCount || 0 };
      })
      .filter(ch => ch.id);

    res.json(conversas);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/grupos', async (req, res) => {
  try {
    const chats = await evoProxy(`/chat/findChats/${EVO_INSTANCE}`);
    const list = Array.isArray(chats) ? chats : (chats?.chats || chats?.data || []);

    const grupoIds = list
      .map(ch => ch.remoteJid || ch.id?.remote || ch.id || '')
      .filter(id => id.includes('@g.us') || id.includes('@lid'))
      .map(id => id.includes('@lid') ? id.replace('@lid', '@g.us') : id);

    const grupos = [];
    for (const gid of grupoIds.slice(0, 50)) {
      try {
        const info = await evoProxy(`/group/findGroupInfos/${EVO_INSTANCE}?groupJid=${encodeURIComponent(gid)}`);
        const name = info?.subject || info?.name || info?.[0]?.subject || gid.split('@')[0];
        grupos.push({ id: gid, name, desc: info?.desc || '', size: info?.size || 0 });
      } catch {
        grupos.push({ id: gid, name: gid.split('@')[0], desc: '', size: 0 });
      }
    }
    res.json(grupos);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/mensagens/:jid', async (req, res) => {
  try {
    const jid = decodeURIComponent(req.params.jid);
    const data = await evoProxy(`/chat/findMessages/${EVO_INSTANCE}`, 'POST', {
      where: { key: { remoteJid: jid } },
    });
    const msgs = (data?.messages?.records || []).slice(-50).map(m => ({
      id: m.key?.id || String(Math.random()),
      body: m.message?.conversation || m.message?.extendedTextMessage?.text || '',
      timestamp: m.messageTimestamp || 0,
      fromMe: m.key?.fromMe || false,
    }));
    res.json(msgs);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/enviar', async (req, res) => {
  try {
    const { number, text } = req.body;
    const result = await evoProxy(`/message/sendText/${EVO_INSTANCE}`, 'POST', {
      number,
      textMessage: { text },
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Scheduler ─────────────────────────────────────────────────
const DIAS = {
  dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6,
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
};

function getHoraBRT() {
  const agora = new Date();
  const horaBRT = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hh = String(horaBRT.getHours()).padStart(2, '0');
  const mm = String(horaBRT.getMinutes()).padStart(2, '0');
  const dataHoje = `${horaBRT.getFullYear()}-${String(horaBRT.getMonth()+1).padStart(2,'0')}-${String(horaBRT.getDate()).padStart(2,'0')}`;
  return { horaAtual: `${hh}:${mm}`, diaAtual: horaBRT.getDay(), diaDoMes: horaBRT.getDate(), dataHoje };
}

async function enviarWhatsApp(phone, message) {
  const numero = phone.replace(/\D/g, '');
  const r = await fetch(`${EVO_URL}/message/sendText/${EVO_INSTANCE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': EVO_KEY },
    body: JSON.stringify({ number: numero, textMessage: { text: message } }),
  });
  return r.json();
}

async function registrarLog(msgId, status, erro = null) {
  await supabase.from('message_logs').insert({
    scheduled_message_id: msgId, status, error: erro, sent_at: new Date().toISOString(),
  });
}

async function verificarEDisparar() {
  const { horaAtual, diaAtual, diaDoMes, dataHoje } = getHoraBRT();
  console.log(`[${new Date().toISOString()}] Verificando — ${horaAtual} BRT | dia: ${diaAtual} | data: ${dataHoje}`);

  const { data: msgs, error } = await supabase
    .from('scheduled_messages')
    .select('id, message, send_time, days_of_week, day_of_month, scheduled_date, one_time, sent_once, contact_id')
    .eq('active', true);

  if (error) { console.error('Erro:', error.message); return; }
  if (!msgs || msgs.length === 0) { console.log('Nenhum agendamento ativo.'); return; }

  for (const msg of msgs) {
    try {
      const horaMensagem = msg.send_time?.slice(0, 5);
      if (horaMensagem !== horaAtual) continue;

      let deveDisparar = false;
      let motivo = '';
      const scheduledDate = msg.scheduled_date ? String(msg.scheduled_date).slice(0, 10) : null;

      console.log(`  msg ${msg.id} | one_time: ${msg.one_time} | scheduled_date: ${scheduledDate} | days_of_week: ${msg.days_of_week}`);

      if (msg.one_time) {
        if (msg.sent_once) { console.log(`  ⏭ já enviada`); continue; }
        if (scheduledDate) {
          deveDisparar = scheduledDate === dataHoje;
          motivo = `data única ${scheduledDate}`;
        } else {
          deveDisparar = true;
          motivo = 'one_time sem data';
        }
      } else if (msg.day_of_month) {
        deveDisparar = msg.day_of_month === diaDoMes;
        motivo = `todo dia ${msg.day_of_month}`;
      } else if (msg.days_of_week) {
        const dias = msg.days_of_week.split(',').map(d => DIAS[d.trim().toLowerCase()]).filter(d => d !== undefined);
        deveDisparar = dias.includes(diaAtual);
        motivo = `dias: ${msg.days_of_week}`;
      }

      console.log(`  → motivo: ${motivo} | dispara: ${deveDisparar}`);
      if (!deveDisparar) continue;

      const { data: contato } = await supabase.from('contacts').select('phone, name').eq('id', msg.contact_id).single();
      const phone = contato?.phone;
      if (!phone) { console.warn(`  ⚠️ Sem telefone — msg ${msg.id}`); continue; }

      console.log(`  → Disparando para ${contato.name} (${phone})`);
      const resultado = await enviarWhatsApp(phone, msg.message);
      console.log('  Resultado:', JSON.stringify(resultado));
      await registrarLog(msg.id, 'sent');

      if (msg.one_time) {
        await supabase.from('scheduled_messages').update({ sent_once: true, active: false }).eq('id', msg.id);
      }
    } catch (err) {
      console.error(`  Erro msg ${msg.id}:`, err.message);
      await registrarLog(msg.id, 'error', err.message);
    }
  }
}

cron.schedule('* * * * *', verificarEDisparar);

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ API rodando na porta ${PORT}`);
  console.log(`✅ Scheduler iniciado — verificando a cada minuto (BRT)`);
});
