fetch('https://rumbo-backend.onrender.com/api/forgot-password', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ correo_electronico: 'marcianoberrati@gmail.com' })
}).then(async res => {
  console.log("Status:", res.status);
  const text = await res.text();
  console.log("Response:", text);
}).catch(console.error);
