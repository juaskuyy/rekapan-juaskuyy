export async function onRequest({request,env}){
 const u=new URL(request.url); if(u.pathname!=='/api') return new Response('Not found',{status:404});
 try{
  if(request.method==='GET'){
   const a=u.searchParams.get('action');
   if(a==='profiles') return json({profiles:(await env.DB.prepare('SELECT id,name FROM profiles ORDER BY name').all()).results});
   if(a==='dashboard'){
    const p=u.searchParams.get('profile');
    const profile=await env.DB.prepare('SELECT id,name FROM profiles WHERE id=?').bind(p).first(); if(!profile) throw Error('Profil tidak ditemukan');
    const period=await env.DB.prepare("SELECT * FROM periods WHERE profile_id=? AND status='active' ORDER BY id DESC LIMIT 1").bind(p).first(); if(!period) throw Error('Shift aktif tidak ditemukan');
    const rooms=(await env.DB.prepare('SELECT id,name,status FROM rooms WHERE profile_id=? ORDER BY id').bind(p).all()).results;
    const tx=(await env.DB.prepare('SELECT t.*,r.name room_name FROM transactions t LEFT JOIN rooms r ON r.id=t.room_id WHERE t.profile_id=? AND t.period_id=? ORDER BY t.id DESC').bind(p,period.id).all()).results;
    const income=tx.filter(x=>x.type==='income').reduce((s,x)=>s+Number(x.amount||0),0), expense=tx.filter(x=>x.type==='expense').reduce((s,x)=>s+Number(x.amount||0),0);
    const roomCash={}; tx.forEach(x=>{if(x.room_id!=null){roomCash[x.room_id]=(roomCash[x.room_id]||0)+(x.type==='income'?1:-1)*Number(x.amount||0)}});
    return json({profile,period,rooms:rooms.map(r=>({...r,cash:roomCash[r.id]||0})),transactions:tx,income,expense,final:income-expense});
   }
   if(a==='history') return json({history:(await env.DB.prepare("SELECT * FROM periods WHERE profile_id=? AND status='closed' ORDER BY id DESC").bind(u.searchParams.get('profile')).all()).results});
   throw Error('Action tidak dikenal');
  }
  if(request.method==='POST'){
   const b=await request.json();
   if(b.action==='room'){await env.DB.prepare('INSERT INTO rooms(profile_id,name,status) VALUES(?,?,?)').bind(b.profile,b.name,b.status||'Kosong').run();return json({ok:true});}
   if(b.action==='transaction'){
    const p=await env.DB.prepare("SELECT id FROM periods WHERE profile_id=? AND status='active' ORDER BY id DESC LIMIT 1").bind(b.profile).first(); if(!p) throw Error('Shift aktif tidak ditemukan');
    await env.DB.prepare('INSERT INTO transactions(profile_id,period_id,room_id,type,source_type,description,amount,transaction_date,transaction_time,notes) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(b.profile,p.id,b.room_id||null,b.type,b.source_type||'other_income',b.description,Number(b.amount),b.date,b.time||null,b.notes||null).run(); return json({ok:true});
   }
   if(b.action==='closing'){
    const p=await env.DB.prepare("SELECT * FROM periods WHERE profile_id=? AND status='active' ORDER BY id DESC LIMIT 1").bind(b.profile).first(); if(!p) throw Error('Shift aktif tidak ditemukan');
    const t=await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) expense FROM transactions WHERE period_id=?").bind(p.id).first();
    await env.DB.prepare('UPDATE periods SET status=\'closed\',closed_at=CURRENT_TIMESTAMP,total_income=?,total_expense=?,final_amount=? WHERE id=?').bind(t.income,t.expense,t.income-t.expense,p.id).run();
    for(const r of (await env.DB.prepare('SELECT * FROM rooms WHERE profile_id=?').bind(b.profile).all()).results) await env.DB.prepare('INSERT INTO closing_rooms(period_id,room_id,room_name,room_status) VALUES(?,?,?,?)').bind(p.id,r.id,r.name,r.status).run();
    await env.DB.prepare("INSERT INTO periods(profile_id,period_number,status) VALUES(?,?,'active')").bind(b.profile,Number(p.period_number)+1).run(); return json({ok:true,total:t.income-t.expense});
   }
   throw Error('Action tidak dikenal');
  }
  return new Response('Method not allowed',{status:405});
 }catch(e){return json({error:e.message},400)}
}
function json(x,s=200){return new Response(JSON.stringify(x),{status:s,headers:{'content-type':'application/json; charset=utf-8'}})}
