const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const axios = require('axios');

const app = express();
app.use(express.json());

// ========== CONFIG ==========
// Replace with YOUR actual values from Twilio/Supabase/Vapi
const SUPABASE_URL = 'YOUR_SUPABASE_URL';  // Get from supabase.com
const SUPABASE_KEY = 'YOUR_SUPABASE_KEY';  // Get from supabase.com

const TWILIO_ACCOUNT_SID = 'YOUR_ACCOUNT_SID';    // From Twilio console
const TWILIO_AUTH_TOKEN = 'YOUR_AUTH_TOKEN';      // From Twilio console
const TWILIO_PHONE = 'YOUR_TWILIO_PHONE';         // Like: +1 (833) 555-0100

const VAPI_AGENT_ID = 'YOUR_VAPI_AGENT_ID';       // From vapi.ai
const VAPI_API_KEY = 'YOUR_VAPI_API_KEY';         // From vapi.ai

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ========== ENDPOINTS ==========

// 1. UPLOAD LEADS AND START CALLING
app.post('/api/leads/upload', async (req, res) => {
  try {
    const { leads } = req.body;
    
    // Save leads to database
    const { data: insertedLeads, error } = await supabase
      .from('leads')
      .insert(leads.map(l => ({
        phone: l.phone,
        name: l.name,
        email: l.email
      })))
      .select();
    
    if (error) throw error;

    // Start calling each lead (staggered, 2 seconds apart)
    for (let i = 0; i < insertedLeads.length; i++) {
      const lead = insertedLeads[i];
      setTimeout(() => {
        makeCall(lead.id, lead.phone, lead.name);
      }, i * 2000); // 2 second delay between calls
    }

    res.json({ 
      success: true, 
      message: `Started calling ${insertedLeads.length} leads`,
      leads: insertedLeads 
    });
  } catch (err) {
    console.error('Error uploading leads:', err);
    res.status(400).json({ error: err.message });
  }
});

// 2. MAKE A CALL
async function makeCall(leadId, prospectPhone, prospectName) {
  try {
    console.log(`📞 Calling ${prospectName} at ${prospectPhone}`);

    // Create call record in database
    const { data: callRecord, error: dbError } = await supabase
      .from('call_records')
      .insert({
        lead_id: leadId,
        call_status: 'initiated'
      })
      .select()
      .single();

    if (dbError) throw dbError;

    // Make actual Twilio call
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE,
      to: prospectPhone,
      url: `${process.env.BACKEND_URL}/twilio/handler?callId=${callRecord.id}&leadId=${leadId}&name=${prospectName}`,
      record: 'record-from-answer',
      timeout: 45
    });

    console.log(`✅ Call initiated: ${call.sid}`);

    // Update database with Twilio call SID
    await supabase
      .from('call_records')
      .update({ 
        twilio_call_sid: call.sid,
        call_status: 'ringing'
      })
      .eq('id', callRecord.id);

  } catch (err) {
    console.error('Error making call:', err);
  }
}

// 3. TWILIO WEBHOOK - WHEN CALL IS ANSWERED
app.post('/twilio/handler', async (req, res) => {
  try {
    const { callId, leadId, name } = req.query;

    console.log(`📱 Call answered by ${name}`);

    // For testing: Play a message then transfer
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    // OPTION A: Transfer directly to Vapi AI agent
    // (Most realistic - sounds like real person)
    response.dial({
      callerId: TWILIO_PHONE
    }).sip(`sip:${VAPI_AGENT_ID}@api.vapi.ai`);

    // OPTION B: Play a message then transfer
    // response.say('Connecting you to an agent...');
    // response.dial({
    //   callerId: TWILIO_PHONE
    // }).sip(`sip:${VAPI_AGENT_ID}@api.vapi.ai`);

    res.type('text/xml');
    res.send(response.toString());

  } catch (err) {
    console.error('Error in call handler:', err);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say('Sorry, there was an error. Goodbye.');
    res.type('text/xml');
    res.send(response.toString());
  }
});

// 4. TWILIO WEBHOOK - CALL STATUS UPDATES
app.post('/twilio/status', async (req, res) => {
  try {
    const { CallSid, CallStatus, CallDuration } = req.body;

    console.log(`📊 Call ${CallSid} status: ${CallStatus}`);

    // Update call record
    await supabase
      .from('call_records')
      .update({
        call_status: CallStatus,
        call_duration_seconds: parseInt(CallDuration) || 0
      })
      .eq('twilio_call_sid', CallSid);

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating status:', err);
    res.status(400).json({ error: err.message });
  }
});

// 5. VAPI WEBHOOK - WHEN AGENT FINISHES CALL
app.post('/api/vapi/callback', async (req, res) => {
  try {
    console.log('🤖 Vapi agent finished call');
    console.log('Received data:', JSON.stringify(req.body, null, 2));

    const { 
      callId,
      transcription, 
      intentScore, 
      willingness,
      issueDescription,
      scheduledTime
    } = req.body;

    // Update call record with AI data
    const updateData = {
      transcription: transcription || '',
      intent_score: intentScore || 0,
      issue_description: issueDescription || '',
      willingness_to_connect: willingness || false,
      call_status: 'completed'
    };

    await supabase
      .from('call_records')
      .update(updateData)
      .eq('id', callId);

    // DECISION LOGIC
    if (scheduledTime) {
      // Prospect wants callback later
      console.log('📅 Scheduling callback for later');
      
      const callRecord = await supabase
        .from('call_records')
        .select('lead_id')
        .eq('id', callId)
        .single();

      await supabase
        .from('scheduled_callbacks')
        .insert({
          lead_id: callRecord.data.lead_id,
          call_record_id: callId,
          scheduled_for: scheduledTime,
          callback_context: {
            transcription,
            issue_description: issueDescription
          }
        });

      await supabase
        .from('call_records')
        .update({ handoff_decision: 'scheduled' })
        .eq('id', callId);
    } 
    else if (willingness && (intentScore || 0) > 60) {
      // High intent - route to human
      console.log('✅ Routing to human agent');
      
      await supabase
        .from('call_records')
        .update({ handoff_decision: 'routed' })
        .eq('id', callId);
    } 
    else {
      // Not interested
      console.log('❌ Not interested');
      
      await supabase
        .from('call_records')
        .update({ handoff_decision: 'rejected' })
        .eq('id', callId);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error in Vapi callback:', err);
    res.status(400).json({ error: err.message });
  }
});

// 6. GET ALL CALLS (for dashboard)
app.get('/api/calls', async (req, res) => {
  try {
    const { data: calls } = await supabase
      .from('call_records')
      .select(`
        id,
        call_status,
        call_duration_seconds,
        intent_score,
        issue_description,
        willingness_to_connect,
        handoff_decision,
        transcription,
        leads(name, phone, email)
      `)
      .order('called_at', { ascending: false })
      .limit(100);
    
    res.json(calls || []);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 7. GET STATS
app.get('/api/stats', async (req, res) => {
  try {
    const { data: calls } = await supabase
      .from('call_records')
      .select('handoff_decision, intent_score, call_status');
    
    const total = calls?.length || 0;
    const completed = calls?.filter(c => c.call_status === 'completed').length || 0;
    const routed = calls?.filter(c => c.handoff_decision === 'routed').length || 0;
    const scheduled = calls?.filter(c => c.handoff_decision === 'scheduled').length || 0;
    const avgIntent = Math.round(
      calls?.reduce((sum, c) => sum + (c.intent_score || 0), 0) / (total || 1)
    ) || 0;
    
    res.json({
      totalCalls: total,
      completedCalls: completed,
      routedCount: routed,
      scheduledCount: scheduled,
      avgIntent: avgIntent
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 8. HEALTH CHECK
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'API is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
});
