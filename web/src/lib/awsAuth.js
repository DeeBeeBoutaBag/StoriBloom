// web/src/lib/awsAuth.js
export async function awsHeaders() {
  // Simple pseudo-anonymous ID stored in session
  let uid = sessionStorage.getItem('aws_user_id');
  if (!uid) {
    uid = 'user-' + Math.random().toString(36).substring(2, 10);
    sessionStorage.setItem('aws_user_id', uid);
  }

  return {
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': uid,
    },
  };
}
