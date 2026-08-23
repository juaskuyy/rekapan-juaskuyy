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
    const tx=(await env.DB.prepare('SELECT t.*,r.name room_name FROM transactions t LEFT JOIN rooms r ON r.id=t.room_id WHERE t.profile_id=? AND t.period_id=? ORDER BY t.transaction_date DESC,t.id DESC').bind(p,period.id).all()).results;
    const income=tx.filter(x=>x.type==='income').reduce((s,x)=>s+Number(x.amount||0),0), expense=tx.filter(x=>x.type==='expense').reduce((s,x)=>s+Number(x.amount||0),0);
    const roomCash={}; tx.forEach(x=>{if(x.room_id!=null){roomCash[x.room_id]=(roomCash[x.room_id]||0)+(x.type==='income'?1:-1)*Number(x.amount||0)}});
    return json({profile,period,rooms:rooms.map(r=>({...r,cash:roomCash[r.id]||0})),transactions:tx,income,expense,final:income-expense});
   }
   if(a==='history'){
    const profile=u.searchParams.get('profile');
    const h=(await env.DB.prepare("SELECT * FROM periods WHERE profile_id=? AND status='closed' ORDER BY id DESC").bind(profile).all()).results;
    return json({history:h});
   }
   if(a==='history_detail'){
    const periodId=u.searchParams.get('period_id');
    const period=await env.DB.prepare('SELECT * FROM periods WHERE id=?').bind(periodId).first(); if(!period) throw Error('Shift tidak ditemukan');
    const rooms=(await env.DB.prepare('SELECT room_id,room_name,room_status,cash_amount FROM closing_rooms WHERE period_id=? ORDER BY id').bind(periodId).all()).results;
    const tx=(await env.DB.prepare('SELECT t.*,r.name room_name FROM transactions t LEFT JOIN rooms r ON r.id=t.room_id WHERE t.period_id=? ORDER BY t.transaction_date,t.id').bind(periodId).all()).results;
    return json({period,rooms,transactions:tx});
   }
   throw Error('Action tidak dikenal');
  }
  if(request.method==='POST'){
   const b=await request.json();
   if(b.action==='room'){
    await env.DB.prepare('INSERT INTO rooms(profile_id,name,status) VALUES(?,?,?)').bind(b.profile,b.name,b.status||'Kosong').run();
    return json({ok:true});
   }
   if(b.action==='transaction'){
    const p=await env.DB.prepare("SELECT id FROM periods WHERE profile_id=? AND status='active' ORDER BY id DESC LIMIT 1").bind(b.profile).first(); if(!p) throw Error('Shift aktif tidak ditemukan');
    await env.DB.prepare('INSERT INTO transactions(profile_id,period_id,room_id,type,source_type,description,amount,transaction_date,transaction_time,notes) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(b.profile,p.id,b.room_id||null,b.type,b.source_type||'other_income',b.description,Number(b.amount),b.date,b.time||null,b.notes||null).run();
    return json({ok:true});
   }
   if(b.action==='delete_transaction'){
    await env.DB.prepare('DELETE FROM transactions WHERE id=? AND profile_id=?').bind(Number(b.id),b.profile).run();
    return json({ok:true});
   }
   if(b.action==='delete_room'){
    await env.DB.prepare('DELETE FROM rooms WHERE id=? AND profile_id=?').bind(Number(b.id),b.profile).run();
    return json({ok:true});
   }
   if(b.action==='delete_history'){
    const period=await env.DB.prepare("SELECT id,period_number FROM periods WHERE id=? AND profile_id=? AND status='closed'").bind(Number(b.id),b.profile).first();
    if(!period) throw Error('Riwayat shift tidak ditemukan atau belum ditutup');
    await env.DB.prepare('DELETE FROM closing_rooms WHERE period_id=?').bind(period.id).run();
    await env.DB.prepare('DELETE FROM transactions WHERE period_id=? AND profile_id=?').bind(period.id,b.profile).run();
    await env.DB.prepare("DELETE FROM periods WHERE id=? AND profile_id=? AND status='closed'").bind(period.id,b.profile).run();
    return json({ok:true,period_number:period.period_number});
   }
   if(b.action==='closing'){
    const p=await env.DB.prepare("SELECT * FROM periods WHERE profile_id=? AND status='active' ORDER BY id DESC LIMIT 1").bind(b.profile).first(); if(!p) throw Error('Shift aktif tidak ditemukan');
    if(!b.start_date || !b.end_date) throw Error('Tanggal mulai dan tanggal selesai wajib diisi');
    if(b.end_date < b.start_date) throw Error('Tanggal selesai tidak boleh sebelum tanggal mulai');
    const t=await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) expense FROM transactions WHERE period_id=?").bind(p.id).first();
    await env.DB.prepare("UPDATE periods SET status='closed',closed_at=CURRENT_TIMESTAMP,start_date=?,end_date=?,total_income=?,total_expense=?,final_amount=? WHERE id=?").bind(b.start_date,b.end_date,t.income,t.expense,t.income-t.expense,p.id).run();
    const rooms=(await env.DB.prepare('SELECT * FROM rooms WHERE profile_id=?').bind(b.profile).all()).results;
    for(const r of rooms){const cash=await env.DB.prepare("SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) cash FROM transactions WHERE period_id=? AND room_id=?").bind(p.id,r.id).first();await env.DB.prepare('INSERT INTO closing_rooms(period_id,room_id,room_name,room_status,cash_amount) VALUES(?,?,?,?,?)').bind(p.id,r.id,r.name,r.status,Number(cash.cash||0)).run();}
    await env.DB.prepare("INSERT INTO periods(profile_id,period_number,status,start_date) VALUES(?,?,'active',?)").bind(b.profile,Number(p.period_number)+1,b.end_date).run();
    return json({ok:true,total:Number(t.income)-Number(t.expense),start_date:b.start_date,end_date:b.end_date});
   }
   throw Error('Action tidak dikenal');
  }
  return new Response('Method not allowed',{status:405});
 }catch(e){return json({error:e.message},400)}
}
function json(x,s=200){return new Response(JSON.stringify(x),{status:s,headers:{'content-type':'application/json; charset=utf-8'}})}
