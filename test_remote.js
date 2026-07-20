const http = require('https');
http.get('https://rumbo-backend.onrender.com/api/users/check-block?userId1=11111111-1111-1111-1111-111111111111&userId2=22222222-2222-2222-2222-222222222222', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('STATUS:', res.statusCode, 'BODY:', data));
}).on('error', err => console.log('ERROR:', err.message));
