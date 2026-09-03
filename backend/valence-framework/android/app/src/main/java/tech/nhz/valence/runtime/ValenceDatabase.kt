package tech.nhz.valence.runtime

import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Native SQLite service. Database files stay in Android's private databases directory. */
class ValenceDatabase(private val context: Context) {
    private val handles = ConcurrentHashMap<String, SQLiteDatabase>()

    fun open(name: String): JSONObject {
        val safe = safeName(name)
        database(safe)
        return JSONObject()
            .put("name", safe)
            .put("path", "/database/$safe")
            .put("native", true)
    }

    fun close(name: String): JSONObject {
        val safe = safeName(name)
        handles.remove(safe)?.close()
        return JSONObject().put("closed", true).put("name", safe)
    }

    fun exec(name: String, sql: String, params: JSONArray): JSONObject {
        rejectBlankSql(sql)
        val db = database(safeName(name))
        if (params.length() == 0) db.execSQL(sql) else db.execSQL(sql, bindArray(params))
        return JSONObject().put("ok", true)
    }

    fun run(name: String, sql: String, params: JSONArray): JSONObject {
        rejectBlankSql(sql)
        val statement = database(safeName(name)).compileStatement(sql)
        return statement.use {
            bindStatement(it, params)
            val verb = sql.trimStart().substringBefore(' ').uppercase()
            when (verb) {
                "INSERT", "REPLACE" -> JSONObject()
                    .put("lastInsertRowId", it.executeInsert())
                    .put("changes", 1)
                "UPDATE", "DELETE" -> JSONObject()
                    .put("lastInsertRowId", JSONObject.NULL)
                    .put("changes", it.executeUpdateDelete())
                else -> {
                    it.execute()
                    JSONObject().put("lastInsertRowId", JSONObject.NULL).put("changes", 0)
                }
            }
        }
    }

    fun all(name: String, sql: String, params: JSONArray): JSONArray {
        rejectBlankSql(sql)
        val values = Array(params.length()) { index ->
            val value = params.opt(index)
            if (value == null || value === JSONObject.NULL) null else value.toString()
        }
        val cursor = database(safeName(name)).rawQuery(sql, values)
        return cursor.use { rows(it) }
    }

    fun get(name: String, sql: String, params: JSONArray): Any {
        val result = all(name, sql, params)
        return if (result.length() == 0) JSONObject.NULL else result.getJSONObject(0)
    }

    private fun database(name: String): SQLiteDatabase =
        handles.getOrPut(name) {
            context.openOrCreateDatabase(name, Context.MODE_PRIVATE, null)
        }

    private fun safeName(input: String): String {
        val name = input.trim()
        if (!name.matches(Regex("[A-Za-z0-9][A-Za-z0-9_.-]{0,127}"))) {
            throw DatabaseException("EINVAL", "invalid database name: $input")
        }
        if (name == "." || name == ".." || name.contains("/")) {
            throw DatabaseException("EPERM", "database path escapes sandbox")
        }
        return if (name.endsWith(".db")) name else "$name.db"
    }

    private fun rejectBlankSql(sql: String) {
        if (sql.isBlank()) throw DatabaseException("EINVAL", "SQL is required")
    }

    private fun bindArray(params: JSONArray): Array<Any?> =
        Array(params.length()) { index ->
            val value = params.opt(index)
            if (value == null || value === JSONObject.NULL) null else value
        }

    private fun bindStatement(statement: SQLiteStatement, params: JSONArray) {
        statement.clearBindings()
        for (index in 0 until params.length()) {
            val position = index + 1
            val value = params.opt(index)
            when (value) {
                null, JSONObject.NULL -> statement.bindNull(position)
                is ByteArray -> statement.bindBlob(position, value)
                is Float -> statement.bindDouble(position, value.toDouble())
                is Double -> statement.bindDouble(position, value)
                is Number -> statement.bindLong(position, value.toLong())
                is Boolean -> statement.bindLong(position, if (value) 1 else 0)
                else -> statement.bindString(position, value.toString())
            }
        }
    }

    private fun rows(cursor: Cursor): JSONArray {
        val output = JSONArray()
        while (cursor.moveToNext()) {
            val row = JSONObject()
            for (index in 0 until cursor.columnCount) {
                val value: Any = when (cursor.getType(index)) {
                    Cursor.FIELD_TYPE_NULL -> JSONObject.NULL
                    Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(index)
                    Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(index)
                    Cursor.FIELD_TYPE_BLOB -> android.util.Base64.encodeToString(
                        cursor.getBlob(index),
                        android.util.Base64.NO_WRAP,
                    )
                    else -> cursor.getString(index)
                }
                row.put(cursor.getColumnName(index), value)
            }
            output.put(row)
        }
        return output
    }
}
