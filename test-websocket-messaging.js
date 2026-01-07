import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';

const USER1_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2OTViNGU3ZTViNTE2NjQxMDYwYjhlMTUiLCJlbWFpbCI6InVzZXIxQGV4YW1wbGUuY29tIiwiaWF0IjoxNzY3NTkxNTUwLCJleHAiOjE3NjgxOTYzNTB9.gtGSjRQ8TKPpngqS6BurBzUe6vV5U7qJOT-AfUySQ20';
const USER2_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2OTViNGU5NjViNTE2NjQxMDYwYjhlMTgiLCJlbWFpbCI6InVzZXIyQGV4YW1wbGUuY29tIiwiaWF0IjoxNzY3NTkxNTc0LCJleHAiOjE3NjgxOTYzNzR9.tO08SeXePLXoImWY99rMRYvFc46hgV_NlZ67wzwQZ7I';
const DISPUTE_ID = '695b5db5bcf45ceab09d0427';
const SERVER_URL = 'http://localhost:5001';

// Track timing
const startTime = Date.now();
const log = (message, ...args) => {
  const elapsed = Date.now() - startTime;
  console.log(`[${elapsed}ms]`, message, ...args);
};

// Decode and verify tokens before connecting
log('🔍 Verifying tokens...');
try {
  const decoded1 = jwt.decode(USER1_TOKEN);
  const decoded2 = jwt.decode(USER2_TOKEN);
  
  log('📋 User 1 Token Info:');
  log('   User ID:', decoded1._id);
  log('   Email:', decoded1.email);
  log('   Issued:', new Date(decoded1.iat * 1000).toISOString());
  log('   Expires:', new Date(decoded1.exp * 1000).toISOString());
  log('   Is Expired:', decoded1.exp * 1000 < Date.now());
  
  log('📋 User 2 Token Info:');
  log('   User ID:', decoded2._id);
  log('   Email:', decoded2.email);
  log('   Expires:', new Date(decoded2.exp * 1000).toISOString());
  log('   Is Expired:', decoded2.exp * 1000 < Date.now());
  
  log('');
} catch (error) {
  log('❌ Token decode error:', error.message);
}

// ============================================
// USER 1 SETUP
// ============================================
log('🚀 Starting User 1 connection...');

const user1 = io(SERVER_URL, {
  auth: { token: USER1_TOKEN },
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 3,
  timeout: 10000,
  transports: ['websocket', 'polling'] // Try both transports
});

// Connection tracking
user1.on('connect', () => {
  log('✅ User 1 CONNECTED:', user1.id);
  log('   Transport:', user1.io.engine.transport.name);
  log('   Auth sent:', !!user1.auth.token);
  log('   Token preview:', USER1_TOKEN.substring(0, 50) + '...');
  log('   Joining dispute...');
  
  user1.emit('join_dispute', { dispute_id: DISPUTE_ID });
});

user1.on('connect_error', (error) => {
  log('❌ User 1 connection error:', error.message);
  log('   Full error:', error);
});

user1.on('disconnect', (reason) => {
  log('🔌 User 1 disconnected:', reason);
  if (reason === 'io server disconnect') {
    log('   ⚠️ Server forcibly disconnected the client');
  }
});

// Dispute events
user1.on('dispute_state', (data) => {
  log('✅ User 1 SUCCESSFULLY JOINED!');
  log('   Role:', data.user_role);
  log('   Status:', data.status);
  log('   Full data:', JSON.stringify(data, null, 2));
  
  // Wait for User 2 to join before sending
  setTimeout(() => {
    log('📤 User 1 sending message...');
    const sendStart = Date.now();
    
    user1.emit('send_message',
      {
        dispute_id: DISPUTE_ID,
        text_content: 'Hello! This is a test message from User 1.'
      },
      (response) => {
        const sendTime = Date.now() - sendStart;
        if (response && response.success) {
          log(`✅ User 1 message sent in ${sendTime}ms`);
          log('   Message ID:', response.message._id);
          log('   Message status:', response.message.status);
        } else {
          log('❌ User 1 send failed:', response ? response.message : 'No response');
        }
      }
    );
  }, 3000); // Wait 3 seconds so User 2 will be connected
});

user1.on('new_message', (data) => {
  log('📨 User 1 received message:');
  log('   From:', data.sender_role);
  log('   Text:', data.message.text_content.substring(0, 50) + '...');
  log('   Status:', data.message.status);
  log('   Message ID:', data.message._id);
});

user1.on('message_status_update', (data) => {
  log(`✓ User 1: Message ${data.message_id} → ${data.status}`);
});

user1.on('user_typing', (data) => {
  log('⌨️ User 1: Other user is typing...');
});

user1.on('user_online', (data) => {
  log('👥 User 1: User came online:', data.user_name || data.user_role);
});

user1.on('user_offline', (data) => {
  log('👥 User 1: User went offline:', data.user_name || data.user_role);
});

user1.on('error', (error) => {
  log('⚠️ User 1 error event:', JSON.stringify(error, null, 2));
  if (error.message === 'Not authenticated') {
    log('   🔑 AUTHENTICATION FAILED!');
    log('   This means the server rejected the token or user permissions');
    log('   Check:');
    log('   1. JWT_SECRET on server matches token signature');
    log('   2. User exists in database with ID:', jwt.decode(USER1_TOKEN)._id);
    log('   3. User is a participant in dispute:', DISPUTE_ID);
  }
});

// ============================================
// USER 2 SETUP (Delayed to avoid collision)
// ============================================
setTimeout(() => {
  log('🚀 Starting User 2 connection...');
  
  const user2 = io(SERVER_URL, {
    auth: { token: USER2_TOKEN },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 3,
    timeout: 10000,
    transports: ['websocket', 'polling']
  });

  user2.on('connect', () => {
    log('✅ User 2 CONNECTED:', user2.id);
    log('   Transport:', user2.io.engine.transport.name);
    log('   Joining dispute...');
    user2.emit('join_dispute', { dispute_id: DISPUTE_ID });
  });

  user2.on('connect_error', (error) => {
    log('❌ User 2 connection error:', error.message);
  });

  user2.on('dispute_state', (data) => {
    log('✅ User 2 SUCCESSFULLY JOINED!');
    log('   Role:', data.user_role);
  });

  user2.on('new_message', (data) => {
    log('📨 User 2 received message:');
    log('   From:', data.sender_role);
    log('   Text:', data.message.text_content.substring(0, 50) + '...');
    
    // Auto-respond to messages from User 1
    if (data.sender_role === 'creator') {
      // Mark as delivered
      setTimeout(() => {
        user2.emit('message_delivered', {
          message_id: data.message._id,
          dispute_id: DISPUTE_ID
        });
        log('✓ User 2: Marked message as delivered');
      }, 300);
      
      // Mark as read
      setTimeout(() => {
        user2.emit('message_read', {
          message_id: data.message._id,
          dispute_id: DISPUTE_ID
        });
        log('✓✓ User 2: Marked message as read');
      }, 1000);
      
      // Send reply
      setTimeout(() => {
        log('📤 User 2 sending reply...');
        const sendStart = Date.now();
        
        user2.emit('send_message',
          {
            dispute_id: DISPUTE_ID,
            text_content: 'Hi User 1! Got your message. WebSocket is working great!'
          },
          (response) => {
            const sendTime = Date.now() - sendStart;
            if (response && response.success) {
              log(`✅ User 2 reply sent in ${sendTime}ms`);
            } else {
              log('❌ User 2 send failed:', response ? response.message : 'No response');
            }
          }
        );
      }, 2000);
    }
  });

  user2.on('message_status_update', (data) => {
    log(`✓ User 2: Message ${data.message_id} → ${data.status}`);
  });

  user2.on('user_online', (data) => {
    log('👥 User 2: User came online:', data.user_name || data.user_role);
  });

  user2.on('user_offline', (data) => {
    log('👥 User 2: User went offline:', data.user_name || data.user_role);
  });

  user2.on('error', (error) => {
    log('⚠️ User 2 error event:', JSON.stringify(error, null, 2));
  });

  // Store for cleanup
  global.user2 = user2;

}, 2000); // Delay User 2 connection by 2 seconds

// ============================================
// CLEANUP & EXIT
// ============================================
setTimeout(() => {
  log('\n' + '='.repeat(60));
  log('✅ Test complete! Cleaning up...');
  log('='.repeat(60) + '\n');
  
  user1.disconnect();
  if (global.user2) global.user2.disconnect();
  
  setTimeout(() => {
    log('👋 Exiting...');
    process.exit(0);
  }, 1000);
}, 15000); // Exit after 15 seconds

// Handle Ctrl+C
process.on('SIGINT', () => {
  log('\n⚠️ Interrupted by user');
  user1.disconnect();
  if (global.user2) global.user2.disconnect();
  process.exit(0);
});

log('\n' + '='.repeat(60));
log('📊 WebSocket Messaging Test Started');
log('⏱️  Monitoring for 15 seconds...');
log('='.repeat(60) + '\n');