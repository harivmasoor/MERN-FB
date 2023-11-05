const { MongoClient, ServerApiVersion } = require('mongodb'); 
const dotenv = require('dotenv');

dotenv.config();

const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: ServerApiVersion.v1 // This is the correct way to specify the server API version
});

async function run() {
  try {
    console.log('MONGO_URI:', process.env.MONGO_URI);
    await client.connect();
    const db = client.db('fileCabinet');

    // Assuming that you want to check the existence of 'chatSessions' as well and create an index on it.
    const pdfCollections = await db.listCollections({ name: 'pdfs' }).toArray();
    if (pdfCollections.length === 0) {
      await db.createCollection('pdfs');
      console.log("Created 'pdfs' collection.");
      // Only create the index if the collection was just created to avoid redundancy
      await db.collection('pdfs').createIndex({ embedding: 1 });
      console.log("Created index on 'embedding' field for 'pdfs' collection.");
    }

    // Now check for 'chatSessions' collection existence and create index accordingly
    const chatSessionsCollections = await db.listCollections({ name: 'chatSessions' }).toArray();
    if (chatSessionsCollections.length === 0) {
      await db.createCollection('chatSessions');
      console.log("Created 'chatSessions' collection.");
    }
    
    // Create an index on the embedding field within the chatHistory array for 'chatSessions' collection
    await db.collection('chatSessions').createIndex({ 'chatHistory.embedding': 1 });
    console.log("Created index on 'chatHistory.embedding' field for 'chatSessions' collection.");
    
  } catch (error) {
    console.error("Error setting up database:", error);
  } finally {
    await client.close();
  }
}

run().catch(console.dir);



