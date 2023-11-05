const { MongoClient, ServerApiVersion } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const uri = process.env.MONGO_URL;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();
    const db = client.db('fileCabinet');
    
    // Check if the 'pdfs' collection exists; create if not
    const collections = await db.listCollections({name: 'pdfs'}).toArray();
    if (collections.length === 0) {
      await db.createCollection('pdfs');
      console.log("Created 'pdfs' collection.");
    }

    // Create a compound search index on the 'embedding' field
    await db.collection('pdfs').createIndex({ embedding: 1 });
    console.log("Created search index on 'embedding' field.");
    
  } catch (error) {
    console.error("Error setting up database:", error);
  } finally {
    await client.close();
  }
}

run().catch(console.dir);


