const request = require( "request-promise-native" );
const parser = require( "http-string-parser" );
const uuidv4 = require( "uuid/v4" );

var AWS = require( "aws-sdk" );
AWS.config.setPromisesDependency( null );

function pprint( input_data ) {
	try {
		console.log(
			JSON.stringify(
				input_data,
				false,
				4
			)
		);
	} catch ( e ) {
		console.log( input_data );
	}
}

async function make_request( protocol, raw_request, input_payload ) {
	// Replace everything in the request string
	for ( var key in input_payload ) {
		if ( input_payload.hasOwnProperty( key ) ) {
			console.log( "Replacing " + key + " -> " + input_payload[ key ] );
			raw_request = raw_request.replace(
				new RegExp(
					key,
					"g"
				),
				input_payload[ key ]
			);
		}
	}
	
    var parsed_request = parser.parseRequest(
    	raw_request
    );

	// Host for URL (we'll get it from the Host header)
	var hostname = false;
	
	for ( var header_key in parsed_request.headers ) {
		if ( parsed_request.headers.hasOwnProperty( header_key ) && header_key.toLowerCase() == "host" ) {
			hostname = parsed_request.headers[ header_key ];
		}
	}
    
    if( !hostname ) {
    	console.error( "No host header found, invalid request!" );
    	return Promise.reject({
    		"error": "No valid host header found!"
    	});
    }

	var request_options = {
    	"method": parsed_request.method,
    	"uri": protocol + "://" + hostname + parsed_request.uri,
    	"headers": parsed_request.headers,
    	// Return more request metadata
    	"transform": function( body, response_object, resolve_with_full_response ) {
			return {
				"headers": response_object.headers,
				"body": body,
				"status": response_object.statusCode
			};
		},
		"simple": false,
	}
	
	if( parsed_request.body !== "" ) {
		request_options.body = parsed_request.body;
	}
	
	console.log( "Making HTTP request to " + request_options.uri );
    
    // Do the request
    var http_response = await request( request_options );
    http_response[ "hostname" ] = hostname;
    
    return http_response;
}

async function invoke_lambda( arn, lambda_input ) {
	var params = {
		FunctionName: arn,
		InvocationType: "RequestResponse",
		LogType: "Tail",
		Payload: JSON.stringify(
			lambda_input
		)
	};
	
	var lambda = new AWS.Lambda();
	
	return lambda.invoke( params ).promise();
}

async function write_to_s3( bucket_name, bucket_path, object_data ) {
	var s3 = new AWS.S3();
    var params = {
    	"Bucket": bucket_name,
    	"Key": bucket_path,
    	"Body": object_data
    };
    
    return s3.putObject(
    	params
    ).promise();
}

module.exports.init = async function( lambda_input, context ) {
	if( !( "payloads" in lambda_input && "raw_request" in lambda_input && "protocol" in lambda_input ) ) {
		console.error( "No 'payloads' key specified, quitting out!" );
		process.exit();
	}
	
	// Take off some work for us to do
	var our_work = [];
	our_work.push(
		lambda_input.payloads.pop()
	);
	
	if ( lambda_input.payloads.length === 1 ) {
		// If there's only one left we'll just do that one as well
		our_work.push(
			lambda_input.payloads.pop()
		);
	} else {
		// If the array can be split into two, then split it up
		// If it doesn't evenly divide we'll take an extra for ourselfs
		if( lambda_input.payloads.length % 2 === 1 ) {
			our_work.push(
				lambda_input.payloads.pop()
			);
		}
	}
	
	// Start our work before invoking other Lambdas
	var our_work_promises = our_work.map(async function( payload_data ) {
		var request_error_occured = false;
		var request_error_data = false;
		var response = await make_request(
			lambda_input.protocol,
			lambda_input.raw_request,
			payload_data
		).catch(function( error ) {
			request_error_occured = true;
			request_error_data = error.toString();
			console.log( "Error occured while doing make_request: " );
			console.log( error );
		});
		
		if( request_error_occured ) {
			return write_to_s3(
				process.env.S3_BUCKET,
				"errors/" + uuidv4() + ".json",
				JSON.stringify(
					{
						"success": false,
						"error": request_error_data,
					},
					false,
					4
				)
			)
		} else {
			response[ "success" ] = true;
			return write_to_s3(
				process.env.S3_BUCKET,
				"responses/" + response.hostname + "-" + uuidv4() + ".json",
				JSON.stringify(
					response,
					false,
					4
				)
			)
		}
	});
	
	// Invocation promises
	var invocation_promises = [];
	
	// Only if we have payloads left
	if( lambda_input.payloads.length ) {
		// Arrays to be used as Lambda invocation inputs
		// First half
		var first_payloads_array = lambda_input.payloads.splice(
			0,
			( lambda_input.payloads.length / 2 )
		);
		// Last half
		var second_payloads_array = lambda_input.payloads;
		
		// Full Lambda invoke inputs
		var first_lambda_invoke_input = {
			"protocol": lambda_input.protocol,
			"raw_request": lambda_input.raw_request,
			"payloads": first_payloads_array
		};
		var second_lambda_invoke_input = {
			"protocol": lambda_input.protocol,
			"raw_request": lambda_input.raw_request,
			"payloads": second_payloads_array
		};
		
		// Invoke both
		invocation_promises.push(
			invoke_lambda(
				context.invokedFunctionArn,
				first_lambda_invoke_input
			)
		);
		invocation_promises.push(
			invoke_lambda(
				context.invokedFunctionArn,
				second_lambda_invoke_input
			)
		);
	}

	// Wait till our work is done
	var our_work_results = await Promise.all( our_work_promises );
}